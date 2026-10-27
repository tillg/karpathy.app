"""Stub of instascraper.cli (v1.1.0): only pace_between_posts, copied."""

from __future__ import annotations

import time


def pace_between_posts(humanizer, fixed_delay, sleep=time.sleep) -> float:
    if humanizer.profile.enabled:
        return humanizer.delay("post")
    if fixed_delay:
        sleep(fixed_delay)
        return fixed_delay
    return 0.0
