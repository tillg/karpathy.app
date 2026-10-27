"""The worker's config: a small TOML file, mode 0600, at ~/.config/karpathy-instagram-worker/config.toml.

`KARPATHY_WORKER_CONFIG` overrides the path. The file holds the worker token, so it is written atomically with mode
0600 in a 0700 directory and never logged.
"""

from __future__ import annotations

import os
import re
import socket
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ENV_PATH = "KARPATHY_WORKER_CONFIG"
DEFAULT_POLL_INTERVAL_S = 60
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ConfigError(Exception):
    """The config is missing or invalid. The message says what to do."""


@dataclass(frozen=True)
class Config:
    server: str
    token: str
    name: str
    poll_interval_s: int = DEFAULT_POLL_INTERVAL_S


def path() -> Path:
    override = os.environ.get(ENV_PATH)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "karpathy-instagram-worker" / "config.toml"


def default_name() -> str:
    """The short host name, reduced to the characters a worker name may have."""
    short = socket.gethostname().split(".")[0]
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", short).strip("-")[:64]
    return name or "worker"


def validate_server(url: str) -> str:
    """The server URL without a trailing slash; https only, http only for this machine (tests, tunnels)."""
    url = url.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return url
    if parts.scheme == "http" and parts.hostname in _LOCAL_HOSTS:
        return url
    raise ConfigError(
        f"server must be an https:// URL, e.g. https://karpathy.example.com (got {url!r}); "
        "http:// is allowed only for localhost"
    )


def validate_name(name: str) -> str:
    if not NAME_RE.match(name):
        raise ConfigError(
            f"worker name {name!r} is not allowed: use 1 to 64 letters, digits, '.', '_' or '-'"
        )
    return name


def validate(cfg: Config) -> Config:
    if not cfg.token.strip():
        raise ConfigError("the worker token is empty")
    if not isinstance(cfg.poll_interval_s, int) or cfg.poll_interval_s < 5:
        raise ConfigError("poll_interval_s must be a whole number of seconds, at least 5")
    return Config(
        server=validate_server(cfg.server),
        token=cfg.token.strip(),
        name=validate_name(cfg.name),
        poll_interval_s=cfg.poll_interval_s,
    )


def load_raw(p: Path | None = None) -> dict:
    """The file's values as they are (for `configure`, which fills in what is missing); {} without a file."""
    p = p or path()
    if not p.exists():
        return {}
    try:
        return tomllib.loads(p.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"cannot read {p}: {exc}. Fix it or run: karpathy-instagram-worker configure") from None


def load(p: Path | None = None) -> Config:
    p = p or path()
    raw = load_raw(p)
    if not raw:
        raise ConfigError(f"no config at {p}. Run: karpathy-instagram-worker configure")
    missing = [k for k in ("server", "token", "name") if not raw.get(k)]
    if missing:
        raise ConfigError(f"{p} lacks {', '.join(missing)}. Run: karpathy-instagram-worker configure")
    try:
        return validate(
            Config(
                server=str(raw["server"]),
                token=str(raw["token"]),
                name=str(raw["name"]),
                poll_interval_s=raw.get("poll_interval_s", DEFAULT_POLL_INTERVAL_S),
            )
        )
    except ConfigError as exc:
        raise ConfigError(f"{p}: {exc}. Run: karpathy-instagram-worker configure") from None


def _toml_str(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = "".join(c if c >= " " else f"\\u{ord(c):04x}" for c in escaped)
    return f'"{escaped}"'


def save(cfg: Config, p: Path | None = None) -> Path:
    """Write the config atomically: a 0600 temp file in a 0700 directory, then rename."""
    p = p or path()
    cfg = validate(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(p.parent, 0o700)
    text = (
        "# karpathy-instagram-worker config. Holds the worker token: keep it private (mode 0600).\n"
        f"server = {_toml_str(cfg.server)}\n"
        f"token = {_toml_str(cfg.token)}\n"
        f"name = {_toml_str(cfg.name)}\n"
        f"poll_interval_s = {cfg.poll_interval_s}\n"
    )
    tmp = p.with_name(f".{p.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            tmp.unlink()
    return p
