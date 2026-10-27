import os
import plistlib
from pathlib import Path

import pytest

from karpathy_instagram_worker import cli, service

EXE = "/Users/till/.local/bin/karpathy-instagram-worker"


@pytest.fixture
def stubs(tmp_path, monkeypatch):
    """launchctl, systemctl and journalctl on PATH: each records its argv in calls.log; STUB_<TOOL>_<SUBCOMMAND>_RC
    sets an exit code and STUB_<TOOL>_<SUBCOMMAND>_OUT what it prints."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    for tool in ("launchctl", "systemctl", "journalctl"):
        script = bin_dir / tool
        sub = "" if tool == "journalctl" else 'for a in "$@"; do case "$a" in -*) ;; *) sub="$a"; break;; esac; done\n'
        script.write_text(
            "#!/bin/sh\n"
            f'echo "{tool} $*" >> "{log}"\n'
            'sub=""\n'
            + sub
            + f'key=$(echo "{tool}_$sub" | tr "a-z-" "A-Z_")\n'
            'eval "out=\\${STUB_${key}_OUT:-}"\n'
            'eval "rc=\\${STUB_${key}_RC:-0}"\n'
            '[ -n "$out" ] && printf "%b\\n" "$out"\n'
            'exit "$rc"\n'
        )
        script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    monkeypatch.delenv("KARPATHY_WORKER_CONFIG", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)

    class Calls:
        def lines(self):
            return log.read_text().splitlines() if log.exists() else []

    return Calls()


def mac(home):
    return service.for_platform("darwin", home=home, exe=EXE)


def linux(home):
    return service.for_platform("linux", home=home, exe=EXE)


# --- macOS -------------------------------------------------------------------------------------------------------

def test_macos_plist_has_run_at_load_keep_alive_the_command_and_logs(stubs, fresh_home):
    svc = mac(fresh_home)
    svc.install()
    plist = fresh_home / "Library/LaunchAgents/app.karpathy.instagram-worker.plist"
    data = plistlib.loads(plist.read_bytes())
    assert data["Label"] == "app.karpathy.instagram-worker"
    assert data["ProgramArguments"] == [EXE, "run"]
    assert data["RunAtLoad"] is True and data["KeepAlive"] is True
    logs = fresh_home / "Library/Logs/karpathy-instagram-worker"
    assert data["StandardOutPath"].startswith(str(logs)) and data["StandardErrorPath"].startswith(str(logs))
    assert logs.is_dir()
    assert "/opt/homebrew/bin" in data["EnvironmentVariables"]["PATH"]  # ffmpeg from Homebrew
    uid = os.getuid()
    assert f"launchctl bootstrap gui/{uid} {plist}" in stubs.lines()


def test_macos_install_prints_what_it_did_and_where_the_logs_are(stubs, fresh_home):
    text = "\n".join(mac(fresh_home).install())
    assert "app.karpathy.instagram-worker.plist" in text
    assert "tail -f" in text and "Library/Logs/karpathy-instagram-worker" in text
    assert "service status" in text


def test_macos_install_twice_replaces_not_duplicates(stubs, fresh_home, monkeypatch):
    svc = mac(fresh_home)
    monkeypatch.setenv("STUB_LAUNCHCTL_PRINT_RC", "113")  # not loaded yet
    svc.install()
    monkeypatch.setenv("STUB_LAUNCHCTL_PRINT_RC", "0")  # loaded now
    svc.install()
    assert len(list((fresh_home / "Library/LaunchAgents").iterdir())) == 1
    lines = stubs.lines()
    uid = os.getuid()
    assert lines.count(f"launchctl bootout gui/{uid}/app.karpathy.instagram-worker") == 1
    assert sum(1 for line in lines if line.startswith("launchctl bootstrap")) == 2
    # the second bootstrap comes after the bootout
    assert lines.index(f"launchctl bootout gui/{uid}/app.karpathy.instagram-worker") < max(
        i for i, line in enumerate(lines) if line.startswith("launchctl bootstrap"))


def test_macos_a_failing_bootstrap_is_a_clear_error(stubs, fresh_home, monkeypatch):
    monkeypatch.setenv("STUB_LAUNCHCTL_BOOTSTRAP_RC", "5")
    monkeypatch.setenv("STUB_LAUNCHCTL_BOOTSTRAP_OUT", "Bootstrap failed: 5: Input/output error")
    with pytest.raises(service.ServiceError, match="Input/output error"):
        mac(fresh_home).install()


def test_macos_uninstall_calls_bootout_and_removes_the_plist(stubs, fresh_home):
    svc = mac(fresh_home)
    svc.install()
    svc.uninstall()
    assert not (fresh_home / "Library/LaunchAgents/app.karpathy.instagram-worker.plist").exists()
    assert f"launchctl bootout gui/{os.getuid()}/app.karpathy.instagram-worker" in stubs.lines()


def test_macos_status_shows_state_pid_and_the_last_log_lines(stubs, fresh_home, monkeypatch):
    svc = mac(fresh_home)
    svc.install()
    log = fresh_home / "Library/Logs/karpathy-instagram-worker/worker.log"
    log.write_text("".join(f"line {i}\n" for i in range(1, 31)))
    monkeypatch.setenv("STUB_LAUNCHCTL_PRINT_OUT", "gui/501/app.karpathy.instagram-worker = {\\n\\tstate = running\\n\\tpid = 4242\\n}")
    text = svc.status()
    assert "running" in text and "4242" in text
    assert "line 30" in text and "line 11" in text and "line 10\n" not in text


def test_macos_status_when_not_installed(stubs, fresh_home, monkeypatch):
    monkeypatch.setenv("STUB_LAUNCHCTL_PRINT_RC", "113")
    text = mac(fresh_home).status()
    assert "not installed" in text and "service install" in text


# --- Linux -------------------------------------------------------------------------------------------------------

def unit_path(home):
    return home / ".config/systemd/user/karpathy-instagram-worker.service"


def test_linux_unit_has_exec_start_and_restart_always_daemon_reload_and_enable_now(stubs, fresh_home):
    linux(fresh_home).install()
    unit = unit_path(fresh_home).read_text()
    assert f"ExecStart={EXE} run" in unit
    assert "Restart=always" in unit and "RestartSec=60" in unit
    assert "WantedBy=default.target" in unit
    lines = stubs.lines()
    assert "systemctl --user daemon-reload" in lines
    assert "systemctl --user enable --now karpathy-instagram-worker.service" in lines
    assert lines.index("systemctl --user daemon-reload") < lines.index(
        "systemctl --user enable --now karpathy-instagram-worker.service")


def test_linux_a_path_with_a_space_or_percent_is_quoted_for_systemd(stubs, fresh_home):
    service.for_platform("linux", home=fresh_home, exe="/home/a b/50%/karpathy-instagram-worker").install()
    assert 'ExecStart="/home/a b/50%%/karpathy-instagram-worker" run' in unit_path(fresh_home).read_text()


def test_linux_install_twice_replaces_and_restarts(stubs, fresh_home, monkeypatch):
    svc = linux(fresh_home)
    svc.install()
    monkeypatch.setenv("STUB_SYSTEMCTL_IS_ACTIVE_OUT", "active")
    svc.install()
    assert len(list(unit_path(fresh_home).parent.iterdir())) == 1
    assert "systemctl --user restart karpathy-instagram-worker.service" in stubs.lines()


def test_linux_install_says_how_to_see_logs_and_about_linger(stubs, fresh_home, monkeypatch, tmp_path):
    monkeypatch.setattr(service, "LINGER_DIR", tmp_path / "linger")
    text = "\n".join(linux(fresh_home).install())
    assert "journalctl --user -u karpathy-instagram-worker -f" in text
    assert "loginctl enable-linger" in text


def test_linux_uninstall_disables_and_removes_the_unit(stubs, fresh_home):
    svc = linux(fresh_home)
    svc.install()
    svc.uninstall()
    assert not unit_path(fresh_home).exists()
    assert "systemctl --user disable --now karpathy-instagram-worker.service" in stubs.lines()


def test_linux_status_shows_state_pid_and_the_journal(stubs, fresh_home, monkeypatch):
    svc = linux(fresh_home)
    svc.install()
    monkeypatch.setenv("STUB_SYSTEMCTL_SHOW_OUT", "LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=777")
    monkeypatch.setenv("STUB_JOURNALCTL__OUT", "Oct 27 12:00:01 box karpathy-instagram-worker[777]: uploaded C0deAbc12")
    text = svc.status()
    assert "active (running)" in text and "777" in text
    assert "uploaded C0deAbc12" in text
    assert "journalctl --user -u karpathy-instagram-worker.service -n 20 --no-pager" in stubs.lines()


def test_the_config_path_override_is_carried_into_the_service(stubs, fresh_home, monkeypatch):
    monkeypatch.setenv("KARPATHY_WORKER_CONFIG", "/etc/kiw.toml")
    linux(fresh_home).install()
    assert "Environment=KARPATHY_WORKER_CONFIG=/etc/kiw.toml" in unit_path(fresh_home).read_text()


def test_another_platform_is_a_clear_error():
    with pytest.raises(service.ServiceError, match="macOS.*Linux"):
        service.for_platform("win32", home=Path("/tmp"), exe=EXE)


def test_cli_service_install_prints_what_was_installed(stubs, fresh_home, monkeypatch, capsys):
    monkeypatch.setattr(service, "PLATFORM", "linux")
    monkeypatch.setattr(service, "command_path", lambda: EXE)
    assert cli.main(["service", "install"]) == 0
    out = capsys.readouterr().out
    assert str(unit_path(fresh_home)) in out and EXE in out
