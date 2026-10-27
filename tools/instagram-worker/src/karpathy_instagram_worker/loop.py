"""The work loop: gate, claim, scrape, upload, report; one job per step.

Each step opens the Instagram account's activity ledger and builds one `Humanizer` on it, as instascraper's CLI does
per run, and asks its gate *before* claiming: a worker that is outside its active hours or past a day ceiling holds no
lease. A step never sleeps itself; it returns how long to wait, so `once` exits at once and `run` waits on an event
that SIGTERM sets (the job in progress still finishes).
"""

from __future__ import annotations

import logging
import signal
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import scrape as scrape_mod
from .client import ApiError, JobClient, NotWorkerMode, ServerUnavailable, TokenRejected
from .config import Config
from .scrape import NeedsLogin, Permanent, RateLimited, Transient
from .upload import ResultRejected, upload

SLEEP_GATE_MAX_S = 30 * 60
SLEEP_NEEDS_LOGIN_S = 10 * 60
SLEEP_RATE_LIMITED_S = 30 * 60
LOGIN_MESSAGE = "run karpathy-instagram-worker login"

log = logging.getLogger("karpathy_instagram_worker.loop")


@dataclass(frozen=True)
class Step:
    state: str  # the state the step reported last
    sleep_s: float  # how long to wait before the next step
    note: str  # one line for the log and for `once`


def _minutes(seconds: float) -> str:
    return f"{seconds / 60:.0f} min" if seconds >= 60 else f"{seconds:.0f} s"


class Worker:
    def __init__(
        self,
        cfg: Config,
        client: JobClient,
        *,
        username: str | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.cfg = cfg
        self.client = client
        self.username = username
        self.sleep = sleep

    # --- reporting ------------------------------------------------------------

    def beat(self, state: str, message: str | None = None) -> None:
        """Best-effort heartbeat: a server hiccup is logged, never ends the step. TokenRejected still propagates."""
        try:
            self.client.heartbeat(state, message)
        except (ServerUnavailable, ApiError) as exc:
            log.warning("heartbeat %s not delivered: %s", state, exc)

    def _verdict(self, job_id: str, reason: str, *, permanent: bool) -> None:
        try:
            self.client.failure(job_id, reason, permanent=permanent)
        except (ServerUnavailable, ApiError) as exc:
            log.warning("could not report the failure of %s (%s); its lease will lapse", job_id, exc)

    def _release(self, job_id: str) -> None:
        try:
            self.client.release(job_id)
        except (ServerUnavailable, ApiError) as exc:
            log.warning("could not release %s (%s); its lease will lapse", job_id, exc)

    # --- one step -------------------------------------------------------------

    def step(self) -> Step:
        from instascraper.activity import ActivityLedger, LedgerBusy, activity_path
        from instascraper.behavior import BehaviorProfile

        username = self.username
        if not username:
            self.beat("needs-login", f"no Instagram account set: {LOGIN_MESSAGE}")
            return Step("needs-login", SLEEP_NEEDS_LOGIN_S, f"no Instagram account set: {LOGIN_MESSAGE}")
        if not scrape_mod.session_path(username).exists():
            # Without a session get_client can't log in by itself; claiming would only churn a lease.
            self.beat("needs-login", LOGIN_MESSAGE)
            return Step("needs-login", SLEEP_NEEDS_LOGIN_S, f"no Instagram session for @{username}: {LOGIN_MESSAGE}")
        profile = BehaviorProfile()
        ledger = ActivityLedger(activity_path(username), window_seconds=profile.window_seconds)
        try:
            with ledger:
                return self._step(profile, ledger, username)
        except LedgerBusy:
            note = f"another instascrape run is using @{username}'s activity ledger"
            self.beat("resting", note)
            return Step("resting", self.cfg.poll_interval_s, note)

    def _step(self, profile, ledger, username: str) -> Step:
        from instascraper.behavior import STOP, WAIT, Humanizer

        humanizer = Humanizer(profile, ledger=ledger, sleep=self.sleep)
        gate = humanizer.gate("post")
        if gate.action == STOP:
            state = "night" if "active hours" in gate.reason else "resting"
            self.beat(state, gate.reason)
            return Step(state, SLEEP_GATE_MAX_S, f"{state}: {gate.reason}")
        if gate.action == WAIT:
            self.beat("resting", gate.reason)
            return Step("resting", min(max(gate.seconds, 1.0), SLEEP_GATE_MAX_S), f"resting: {gate.reason}")

        try:
            job = self.client.claim()
        except NotWorkerMode:
            note = "the server is in local mode (instagram_source: local): it scrapes itself and has no jobs"
            self.beat("idle", note)
            return Step("idle", self.cfg.poll_interval_s, note)
        if job is None:
            self.beat("idle")
            return Step("idle", self.cfg.poll_interval_s, "no job")

        log.info("claimed %s (%s)", job.id, job.url)
        self.beat("scraping", job.id)
        pace = humanizer.sample_delay("post")
        with tempfile.TemporaryDirectory(prefix="karpathy-worker-") as tmp:
            try:
                out = scrape_mod.scrape_post(job.id, job.url, Path(tmp), humanizer=humanizer, username=username)
            except NeedsLogin as exc:
                log.error("%s: %s", job.id, exc.reason)
                self._release(job.id)
                self.beat("needs-login", LOGIN_MESSAGE)
                return Step("needs-login", SLEEP_NEEDS_LOGIN_S, f"{exc.reason} (job {job.id} released)")
            except RateLimited as exc:
                log.warning("%s: %s", job.id, exc.reason)
                self._release(job.id)
                self.beat("rate-limited", exc.reason)
                return Step("rate-limited", SLEEP_RATE_LIMITED_S, f"{exc.reason} (job {job.id} released)")
            except Permanent as exc:
                log.warning("%s can't be scraped: %s", job.id, exc.reason)
                self._verdict(job.id, exc.reason, permanent=True)
                self.beat("idle")
                return Step("idle", pace, f"{job.id}: {exc.reason} (reported as permanent)")
            except Transient as exc:
                log.error("%s failed: %s", job.id, exc.reason)
                self._verdict(job.id, exc.reason, permanent=False)
                self.beat("error", exc.reason)
                return Step("error", pace, f"{job.id}: {exc.reason} (the server retries it later)")

            try:
                upload(self.client, job.id, out)
            except ResultRejected as exc:
                log.warning("%s: %s", job.id, exc)
                self._verdict(job.id, str(exc), permanent=True)
                self.beat("idle")
                return Step("idle", pace, f"{job.id}: {exc} (reported as permanent)")
            except ApiError as exc:
                if exc.status == 404 and exc.error == "unknown-job":
                    log.info("%s: the server no longer wants it (%s)", job.id, exc)
                    self.beat("idle")
                    return Step("idle", pace, f"{job.id}: not wanted any more")
                # Any other refusal (an upload cut short, 408, 411, …) says nothing about the post: a non-permanent
                # failure, so the server's backoff applies instead of the post being claimed again at once.
                reason = f"upload refused: {exc}"[:200]
                log.error("%s: %s", job.id, reason)
                self._verdict(job.id, reason, permanent=False)
                self.beat("error", reason)
                return Step("error", pace, f"{job.id}: {reason} (the server retries it later)")
        log.info("uploaded %s", job.id)
        self.beat("idle")
        return Step("idle", pace, f"uploaded {job.id}")

    # --- the loop -------------------------------------------------------------

    def run(self, stop: threading.Event, wait: Callable[[float], object] | None = None) -> None:
        """Steps until `stop` is set. TokenRejected propagates (the service manager restarts the process later)."""
        wait = wait or stop.wait
        while not stop.is_set():
            try:
                step = self.step()
            except TokenRejected:
                raise
            except ServerUnavailable as exc:
                log.error("%s", exc)
                step = Step("error", self.cfg.poll_interval_s, str(exc))
            except Exception as exc:  # keep the service alive; the traceback goes to the log
                log.exception("step failed unexpectedly: %s", exc)
                step = Step("error", self.cfg.poll_interval_s, f"{type(exc).__name__}: {exc}")
            log.info("%s; next step in %s", step.note, _minutes(step.sleep_s))
            if not stop.is_set():
                wait(step.sleep_s)
        log.info("stopped")


def install_stop_handlers(stop: threading.Event) -> dict:
    """SIGTERM (launchctl bootout, systemctl stop) and SIGINT end the loop after the current job. Returns the previous
    handlers, for `restore_handlers`."""

    def handler(signum, _frame):
        log.info("got %s: stopping after the current step", signal.Signals(signum).name)
        stop.set()

    return {sig: signal.signal(sig, handler) for sig in (signal.SIGTERM, signal.SIGINT)}


def restore_handlers(previous: dict) -> None:
    for sig, old in previous.items():
        signal.signal(sig, old)
