"""`service install|uninstall|status`: run the worker in the background with the OS's own supervisor.

macOS: a LaunchAgent (`~/Library/LaunchAgents/app.karpathy.instagram-worker.plist`), logs in
`~/Library/Logs/karpathy-instagram-worker/`. It runs while the user is logged in, which is what a laptop wants.
Linux: a systemd user unit (`~/.config/systemd/user/karpathy-instagram-worker.service`), logs in the journal. Both
run the absolute path of the installed command with `run`, and restart it when it exits.
"""

from __future__ import annotations

import getpass
import os
import re
import shutil
import subprocess
import sys
from importlib import resources
from pathlib import Path
from string import Template
from xml.sax.saxutils import escape

from .config import ENV_PATH

PROG = "karpathy-instagram-worker"
LABEL = "app.karpathy.instagram-worker"
UNIT = f"{PROG}.service"
PLATFORM = sys.platform
LINGER_DIR = Path("/var/lib/systemd/linger")
LOG_LINES = 20
# launchd starts agents with a bare PATH; ffmpeg (for Reels) usually comes from Homebrew.
MAC_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


class ServiceError(Exception):
    """Installing, removing or querying the service failed. The message says why."""


def command_path() -> str:
    """The absolute path of the installed `karpathy-instagram-worker` (pipx puts it in ~/.local/bin)."""
    argv0 = Path(sys.argv[0])
    if argv0.name == PROG and argv0.exists():
        return str(argv0.absolute())
    found = shutil.which(PROG)
    if found:
        return str(Path(found).absolute())
    raise ServiceError(
        f"can't find the installed {PROG} command. Install it with pipx first (see the setup guide), then run "
        f"`{PROG} service install` from that installation"
    )


def _template(name: str) -> Template:
    return Template(resources.files("karpathy_instagram_worker").joinpath("templates", name).read_text("utf-8"))


def _run(*argv: str, check: bool = True) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(list(argv), capture_output=True, text=True)
    except FileNotFoundError:
        raise ServiceError(f"`{argv[0]}` not found on PATH") from None
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip() or f"exit code {proc.returncode}"
        raise ServiceError(f"`{' '.join(argv)}` failed: {detail}")
    return proc


def _carried_env() -> dict[str, str]:
    """Environment the service needs from this shell: a non-default config path."""
    env = {}
    if os.environ.get(ENV_PATH):
        env[ENV_PATH] = str(Path(os.environ[ENV_PATH]).expanduser().absolute())
    return env


def _tail(path: Path, n: int = LOG_LINES) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except OSError:
        return []


class Launchd:
    def __init__(self, home: Path, exe: str | None) -> None:
        self.home = home
        self.exe = exe
        self.plist = home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
        self.log_dir = home / "Library" / "Logs" / PROG
        self.log = self.log_dir / "worker.log"
        self.domain = f"gui/{os.getuid()}"
        self.target = f"{self.domain}/{LABEL}"

    def render(self, exe: str) -> str:
        env = {"PATH": MAC_PATH, "PYTHONUNBUFFERED": "1", **_carried_env()}
        environment = "\n".join(
            f"    <key>{escape(k)}</key>\n    <string>{escape(v)}</string>" for k, v in env.items()
        )
        return _template("launchd.plist").substitute(
            label=LABEL, exe=escape(exe), log=escape(str(self.log)), environment=environment
        )

    def installed(self) -> bool:
        return self.plist.exists()

    def loaded(self) -> bool:
        return _run("launchctl", "print", self.target, check=False).returncode == 0

    def install(self) -> list[str]:
        exe = self.exe or command_path()
        self.plist.parent.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        replaced = self.plist.exists()
        if self.loaded():
            _run("launchctl", "bootout", self.target, check=False)
        self.plist.write_text(self.render(exe), encoding="utf-8")
        _run("launchctl", "enable", self.target, check=False)
        _run("launchctl", "bootstrap", self.domain, str(self.plist))
        return [
            f"{'Replaced' if replaced else 'Installed'} the LaunchAgent {self.plist}",
            f"  runs: {exe} run  (at login, restarted when it exits)",
            f"  logs: {self.log}",
            f"Follow the log:  tail -f {self.log}",
            f"Check it:        {PROG} service status",
        ]

    def uninstall(self) -> list[str]:
        _run("launchctl", "bootout", self.target, check=False)
        existed = self.plist.exists()
        if existed:
            self.plist.unlink()
        return [f"Removed {self.plist}" if existed else f"No LaunchAgent at {self.plist}; nothing to remove",
                f"(logs stay in {self.log_dir})"]

    def running(self) -> bool:
        proc = _run("launchctl", "print", self.target, check=False)
        return proc.returncode == 0 and re.search(r"^\s*state = running", proc.stdout, re.M) is not None

    def status(self) -> str:
        proc = _run("launchctl", "print", self.target, check=False)
        if proc.returncode != 0:
            head = (
                f"LaunchAgent {LABEL}: not loaded ({self.plist} exists; run `{PROG} service install` again)"
                if self.plist.exists()
                else f"LaunchAgent {LABEL}: not installed. Run: {PROG} service install"
            )
        else:
            state = re.search(r"^\s*state = (\S+)", proc.stdout, re.M)
            pid = re.search(r"^\s*pid = (\d+)", proc.stdout, re.M)
            head = f"LaunchAgent {LABEL}: {state.group(1) if state else 'loaded'}" + (
                f", pid {pid.group(1)}" if pid else ""
            )
        lines = _tail(self.log)
        body = "\n".join(lines) if lines else "(no log lines yet)"
        return f"{head}\nLast {LOG_LINES} log lines ({self.log}):\n{body}"


def _systemd_quote(value: str) -> str:
    value = value.replace("%", "%%")
    if re.search(r'[\s"\'\\]', value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


class Systemd:
    def __init__(self, home: Path, exe: str | None) -> None:
        self.home = home
        self.exe = exe
        xdg = os.environ.get("XDG_CONFIG_HOME", "")
        config_home = Path(xdg) if xdg.startswith("/") else home / ".config"
        self.unit_path = config_home / "systemd" / "user" / UNIT

    def render(self, exe: str) -> str:
        env = {"PYTHONUNBUFFERED": "1", **_carried_env()}
        environment = "\n".join(f"Environment={_systemd_quote(f'{k}={v}')}" for k, v in env.items())
        return _template("systemd.service").substitute(
            exec_start=f"{_systemd_quote(exe)} run", environment=environment
        )

    def _ctl(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return _run("systemctl", "--user", *args, check=check)

    def install(self) -> list[str]:
        exe = self.exe or command_path()
        self.unit_path.parent.mkdir(parents=True, exist_ok=True)
        replaced = self.unit_path.exists()
        self.unit_path.write_text(self.render(exe), encoding="utf-8")
        self._ctl("daemon-reload")
        was_active = self._ctl("is-active", UNIT, check=False).stdout.strip() == "active"
        self._ctl("enable", "--now", UNIT)
        if was_active:
            self._ctl("restart", UNIT)  # enable --now leaves a running unit on the old binary
        lines = [
            f"{'Replaced' if replaced else 'Installed'} the systemd user unit {self.unit_path}",
            f"  runs: {exe} run  (restarted when it exits)",
            f"Follow the log:  journalctl --user -u {PROG} -f",
            f"Check it:        {PROG} service status",
        ]
        user = getpass.getuser()
        if not (LINGER_DIR / user).exists():
            lines.append(
                f"Note: user services stop when you log out. On a headless box run once: "
                f"sudo loginctl enable-linger {user}"
            )
        return lines

    def uninstall(self) -> list[str]:
        self._ctl("disable", "--now", UNIT, check=False)
        existed = self.unit_path.exists()
        if existed:
            self.unit_path.unlink()
        self._ctl("daemon-reload", check=False)
        return [f"Removed {self.unit_path}" if existed else f"No unit at {self.unit_path}; nothing to remove"]

    def _show(self) -> dict[str, str]:
        proc = self._ctl("show", UNIT, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID",
                         check=False)
        return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)

    def running(self) -> bool:
        return self._show().get("ActiveState") == "active"

    def status(self) -> str:
        if not self.unit_path.exists():
            head = f"systemd user unit {UNIT}: not installed. Run: {PROG} service install"
        else:
            props = self._show()
            head = f"systemd user unit {UNIT}: {props.get('ActiveState', 'unknown')} ({props.get('SubState', '?')})"
            if props.get("MainPID", "0") != "0":
                head += f", pid {props['MainPID']}"
        journal = _run("journalctl", "--user", "-u", UNIT, "-n", str(LOG_LINES), "--no-pager", check=False)
        body = journal.stdout.rstrip() or "(no journal lines)"
        return f"{head}\nLast {LOG_LINES} log lines (journalctl --user -u {PROG}):\n{body}"

    def installed(self) -> bool:
        return self.unit_path.exists()


def for_platform(platform: str | None = None, *, home: Path | None = None, exe: str | None = None):
    platform = platform or PLATFORM
    home = home or Path.home()
    if platform == "darwin":
        return Launchd(home, exe)
    if platform.startswith("linux"):
        return Systemd(home, exe)
    raise ServiceError(f"`service` supports macOS (launchd) and Linux (systemd), not {platform!r}")
