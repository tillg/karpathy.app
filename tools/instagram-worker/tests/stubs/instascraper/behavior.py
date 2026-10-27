"""Stub of instascraper.behavior (v1.1.0): same names and signatures; the gate's verdict comes from NEXT_GATE."""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from datetime import datetime

PROCEED = "proceed"
WAIT = "wait"
STOP = "stop"


@dataclass(frozen=True)
class Range:
    lo: float
    hi: float


@dataclass(frozen=True)
class GateResult:
    action: str
    seconds: float = 0.0
    reason: str = ""


@dataclass(frozen=True)
class BehaviorProfile:
    enabled: bool = True
    post_delay: Range = Range(20.0, 90.0)
    window_seconds: int = 3600


# What the next `gate()` answers (tests set it).
NEXT_GATE = GateResult(PROCEED)
# Every Humanizer built, newest last.
BUILT: list["Humanizer"] = []
# What `sample_delay("post")` returns.
POST_DELAY = 42.0


class Humanizer:
    def __init__(self, profile: BehaviorProfile | None = None, rng: random.Random | None = None, sleep=time.sleep,
                 now=time.time, wall=datetime.now, ledger=None) -> None:
        self.profile = profile if profile is not None else BehaviorProfile()
        self._sleep = sleep
        self.ledger = ledger
        self.recorded: list[str] = []
        self.gates: list[str] = []
        BUILT.append(self)

    def gate(self, kind: str = "request") -> GateResult:
        self.gates.append(kind)
        return NEXT_GATE

    def record(self, kind: str = "request") -> None:
        self.recorded.append(kind)

    def sample_delay(self, kind: str = "request") -> float:
        return POST_DELAY if self.profile.enabled else 0.0

    def delay(self, kind: str = "request") -> float:
        seconds = self.sample_delay(kind)
        if seconds > 0:
            self._sleep(seconds)
        return seconds

    def wait(self, seconds: float) -> None:
        if seconds > 0:
            self._sleep(seconds)
