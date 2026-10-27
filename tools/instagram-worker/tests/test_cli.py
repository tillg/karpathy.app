import io
import os
import sys

import instascraper.auth as auth
import instascraper.config as iconfig
import pytest

from karpathy_instagram_worker import cli, config, service

PASSWORD = "not-a-real-password"  # distinctive, so a leak into output or files is found


@pytest.fixture
def password(monkeypatch):
    prompts = []

    def fake_getpass(prompt=""):
        prompts.append(prompt)
        return PASSWORD

    monkeypatch.setattr("getpass.getpass", fake_getpass)
    return prompts


def all_file_text(root):
    for dirpath, _, files in os.walk(root):
        for f in files:
            yield open(os.path.join(dirpath, f), "rb").read().decode("utf-8", "replace")


# --- help --------------------------------------------------------------------------------------------------------

def test_help_lists_configure_login_doctor_once_run_service_version(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["--help"])
    assert e.value.code == 0
    out = capsys.readouterr().out
    for command in ("configure", "login", "doctor", "once", "run", "service", "version"):
        assert command in out


# --- login -------------------------------------------------------------------------------------------------------

def test_login_passes_username_password_and_a_code_callback_that_reads_stdin(password, monkeypatch, capsys):
    monkeypatch.setattr(auth, "LOGIN_ASKS_CODE_VIA", "SMS")
    monkeypatch.setattr(sys, "stdin", io.StringIO("123456\n"))
    assert cli.main(["login", "--username", "tills"]) == 0
    [call] = auth.LOGIN_CALLS
    assert call["username"] == "tills" and call["password"] == PASSWORD
    assert call["code_value"] == "123456"
    assert len(password) == 1 and "@tills" in password[0]
    assert "SMS" in capsys.readouterr().out


def test_login_writes_ig_username_to_instascrapers_env(password):
    assert cli.main(["login", "--username", "tills"]) == 0
    assert iconfig.load_config(iconfig.CONFIG_PATH)["IG_USERNAME"] == "tills"
    assert (auth.DEFAULT_SESSION_DIR / "session-tills.json").exists()


def test_login_takes_the_remembered_username(password):
    iconfig.save_config({"IG_USERNAME": "tills"}, path=iconfig.CONFIG_PATH)
    assert cli.main(["login"]) == 0
    assert auth.LOGIN_CALLS[0]["username"] == "tills"


def test_login_asks_for_a_username_when_none_is_known(password, monkeypatch):
    monkeypatch.setattr("builtins.input", lambda prompt="": "@tills ")
    assert cli.main(["login"]) == 0
    assert auth.LOGIN_CALLS[0]["username"] == "tills"


def test_the_password_never_reaches_stdout_stderr_or_any_file(password, monkeypatch, capsys, fresh_home):
    assert cli.main(["login", "--username", "tills"]) == 0
    monkeypatch.setattr(auth, "LOGIN_RAISES", auth.LoginFailed("ClientError: something *** went wrong"))
    assert cli.main(["login", "--username", "tills"]) == 1
    out = capsys.readouterr()
    assert PASSWORD not in out.out + out.err
    assert all(PASSWORD not in text for text in all_file_text(fresh_home))


def test_a_rejected_password_says_so_and_exits_1(password, monkeypatch, capsys):
    monkeypatch.setattr(auth, "LOGIN_RAISES", auth.BadPassword("Instagram rejected the username or password"))
    assert cli.main(["login", "--username", "tills"]) == 1
    assert "rejected the username or password" in capsys.readouterr().err
    assert "IG_USERNAME" not in iconfig.load_config(iconfig.CONFIG_PATH)


def test_login_with_browser_imports_the_browser_session(monkeypatch, capsys):
    assert cli.main(["login", "--username", "tills", "--browser", "safari"]) == 0
    [call] = auth.GET_CLIENT_CALLS
    assert call["browser"] == "safari" and call["username"] == "tills"
    assert auth.LOGIN_CALLS == []
    assert iconfig.load_config(iconfig.CONFIG_PATH)["IG_USERNAME"] == "tills"


def test_login_with_browser_reports_its_failure(monkeypatch, capsys):
    monkeypatch.setattr(auth, "GET_CLIENT_RAISES", SystemExit("No active Instagram login found in safari."))
    assert cli.main(["login", "--username", "tills", "--browser", "safari"]) == 1
    assert "No active Instagram login found in safari" in capsys.readouterr().err


# --- doctor ------------------------------------------------------------------------------------------------------

class FakeService:
    def __init__(self, installed=True, running=True):
        self._installed, self._running = installed, running

    def installed(self):
        return self._installed

    def running(self):
        return self._running


@pytest.fixture
def healthy(server, monkeypatch, tmp_path):
    """A worker that passes every check: config, server, session, ffmpeg, service."""
    config.save(config.Config(server=server.url, token="tok", name="mbp"))
    iconfig.save_config({"IG_USERNAME": "tills"}, path=iconfig.CONFIG_PATH)
    (auth.DEFAULT_SESSION_DIR / "session-tills.json").write_text("{}")
    bin_dir = tmp_path / "fakebin"
    bin_dir.mkdir()
    (bin_dir / "ffmpeg").write_text("#!/bin/sh\n")
    (bin_dir / "ffmpeg").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    monkeypatch.setattr(service, "for_platform", lambda *a, **k: FakeService())
    return server


def doctor_lines(capsys):
    return [line for line in capsys.readouterr().out.splitlines() if line.strip()]


def test_doctor_prints_one_line_per_check_and_exits_0_when_healthy(healthy, capsys):
    assert cli.main(["doctor"]) == 0
    lines = doctor_lines(capsys)
    checks = [line for line in lines if line.split()[0] in ("ok", "warn", "FAIL")]
    assert len(checks) == 7
    assert all(line.startswith("ok") for line in checks)
    assert healthy.json_bodies("POST", "/worker/heartbeat")[0]["message"] == "doctor"


def test_doctor_exits_1_on_a_rejected_token(healthy, capsys):
    healthy.script("POST", "/worker/heartbeat", (401, None))
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out
    fail = [line for line in out.splitlines() if line.startswith("FAIL")]
    assert len(fail) == 1 and "rejected" in fail[0]
    assert "just instagram-worker-token" in out


def test_doctor_treats_a_missing_ffmpeg_as_a_warning(healthy, monkeypatch, capsys):
    monkeypatch.setattr("shutil.which", lambda name, *a, **k: None if name == "ffmpeg" else "/usr/bin/" + name)
    assert cli.main(["doctor"]) == 0
    lines = doctor_lines(capsys)
    assert any(line.startswith("warn") and "ffmpeg" in line for line in lines)


def test_doctor_fails_a_config_readable_by_others(healthy, capsys):
    os.chmod(config.path(), 0o644)
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert any(line.startswith("FAIL") and "0644" in line for line in out.splitlines())
    assert f"chmod 600 {config.path()}" in out


def test_doctor_fails_without_an_instagram_session(healthy, capsys):
    (auth.DEFAULT_SESSION_DIR / "session-tills.json").unlink()
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert any(line.startswith("FAIL") and "session" in line for line in out.splitlines())
    assert "karpathy-instagram-worker login" in out


def test_doctor_warns_when_the_service_is_not_installed(healthy, monkeypatch, capsys):
    monkeypatch.setattr(service, "for_platform", lambda *a, **k: FakeService(installed=False, running=False))
    assert cli.main(["doctor"]) == 0
    lines = doctor_lines(capsys)
    assert any(line.startswith("warn") and "service not installed" in line for line in lines)
    assert any("karpathy-instagram-worker service install" in line for line in lines)


def test_doctor_without_a_config_fails_and_skips_the_server_check(monkeypatch, capsys):
    monkeypatch.setattr(service, "for_platform", lambda *a, **k: FakeService(installed=False, running=False))
    assert cli.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert "karpathy-instagram-worker configure" in out
    assert "Traceback" not in out
    assert any(line.startswith("skip") and "server" in line for line in out.splitlines())
    assert "2 required check(s) failed" in out  # config and the Instagram account; a skipped check isn't one
