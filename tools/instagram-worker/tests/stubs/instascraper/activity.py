"""Stub of instascraper.activity (v1.1.0): same names and constructor; no lock, no file."""

from __future__ import annotations

import time
from pathlib import Path

from .config import CONFIG_DIR

DEFAULT_LOCK_TIMEOUT = 5.0

# Every ledger the worker opened, newest last (tests read it).
OPENED: list["ActivityLedger"] = []
# Set to make the next `__enter__` raise LedgerBusy.
BUSY = False


class LedgerBusy(RuntimeError):
    pass


class Activity:
    pass


def activity_path(username: str | None, override: str | None = None) -> Path:
    if override:
        return Path(override)
    name = f"activity-{username}.json" if username else "activity.json"
    return CONFIG_DIR / name


class ActivityLedger:
    def __init__(self, path, *, window_seconds: int, lock_timeout: float | None = None, now=time.time,
                 sleep=time.sleep, enabled: bool = True) -> None:
        self.path = Path(path)
        self.window_seconds = window_seconds
        self.enabled = enabled
        self.activity = Activity()
        self.entered = False
        self.exited = False
        OPENED.append(self)

    def __enter__(self) -> "ActivityLedger":
        if BUSY:
            raise LedgerBusy(str(self.path) + ".lock")
        self.entered = True
        return self

    def __exit__(self, *exc) -> None:
        self.exited = True

    def flush(self) -> None:
        pass
