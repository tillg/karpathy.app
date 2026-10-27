"""Copy of instascraper.config (v1.1.0), reduced to what the worker uses."""

from __future__ import annotations

import os
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "instascraper"
CONFIG_PATH = CONFIG_DIR / ".env"


def load_config(path: Path = CONFIG_PATH) -> dict[str, str]:
    cfg: dict[str, str] = {}
    if not path.exists():
        return cfg
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        cfg[key.strip()] = value.strip()
    return cfg


def save_config(updates: dict[str, str], path: Path = CONFIG_PATH) -> None:
    cfg = load_config(path)
    for key, value in updates.items():
        if value is not None and value != "":
            cfg[key] = str(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# instascraper config — credentials + option defaults."]
    lines += [f"{k}={v}" for k, v in cfg.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
