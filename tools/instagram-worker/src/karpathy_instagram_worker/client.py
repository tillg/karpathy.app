"""The job API client (`/api/ingest/instagram/...`), on the standard library only.

Every call carries the worker token. An unreachable server or a 5xx answer is retried after 1, 2 and 5 minutes, then
`ServerUnavailable` is raised; a 401 raises `TokenRejected` at once. Sleeps are injected so tests never wait.
"""

from __future__ import annotations

import http.client
import json
import logging
import re
import ssl
import time
import urllib.error
import urllib.request
from typing import Callable, NamedTuple

from . import __version__

API = "/api/ingest/instagram"
BACKOFF_S = (60, 120, 300)
SHORTCODE_RE = re.compile(r"^[A-Za-z0-9_-]{5,40}$")
REASON_MAX = 200
STATES = ("idle", "scraping", "night", "resting", "needs-login", "rate-limited", "error")

log = logging.getLogger("karpathy_instagram_worker.client")


class Job(NamedTuple):
    id: str
    url: str
    lease_until: str


class TokenRejected(Exception):
    """The server answered 401: the worker token is wrong or was rotated."""


class ServerUnavailable(Exception):
    """The server could not be reached, or kept answering 5xx, through every retry."""


class NotWorkerMode(Exception):
    """The server scrapes Instagram itself (instagram_source: local) and hands out no jobs."""


class ApiError(Exception):
    """Any other refusal (4xx). `error` is the server's error code, `message` its explanation, if any."""

    def __init__(self, status: int, error: str = "", message: str = "") -> None:
        self.status, self.error, self.message = status, error, message
        super().__init__(f"HTTP {status}" + (f" {error}" if error else "") + (f": {message}" if message else ""))


class _Retryable(Exception):
    pass


def parse_error(status: int, body: bytes) -> ApiError:
    try:
        data = json.loads(body or b"{}")
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return ApiError(status, str(data.get("error") or ""), str(data.get("message") or ""))


def is_cert_error(exc: BaseException) -> bool:
    reason = getattr(exc, "reason", exc)
    return isinstance(reason, ssl.SSLCertVerificationError)


def cert_hint(server: str) -> str:
    return (
        f"the TLS certificate of {server} is not trusted by this Python. For a dev stack with its own CA set "
        "SSL_CERT_FILE to that CA's root certificate; on macOS with python.org's Python run its "
        "'Install Certificates.command'"
    )


class JobClient:
    def __init__(
        self,
        server: str,
        token: str,
        name: str,
        *,
        version: str = __version__,
        sleep: Callable[[float], None] = time.sleep,
        backoff: tuple[float, ...] = BACKOFF_S,
        timeout: float = 30.0,
    ) -> None:
        self.server = server.rstrip("/")
        self.token = token
        self.name = name
        self.version = version
        self.sleep = sleep
        self.backoff = tuple(backoff)
        self.timeout = timeout

    # --- plumbing -----------------------------------------------------------

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": f"karpathy-instagram-worker/{self.version}"}

    def url(self, path: str) -> str:
        return f"{self.server}{API}{path}"

    def retrying(self, what: str, attempt: Callable[[], tuple[int, bytes]]) -> tuple[int, bytes]:
        """Run `attempt()` (one HTTP exchange → status, body) with the backoff for unreachable/5xx. 401 raises
        TokenRejected; other statuses are returned."""
        delays = list(self.backoff)
        while True:
            try:
                status, body = attempt()
                if status >= 500:
                    raise _Retryable(f"HTTP {status}")
            except _Retryable as exc:
                problem = str(exc)
            except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
                if is_cert_error(exc):
                    raise ServerUnavailable(cert_hint(self.server)) from None
                problem = f"{type(exc).__name__}: {getattr(exc, 'reason', exc)}"
            else:
                if status == 401:
                    raise TokenRejected(f"the server {self.server} rejected the worker token")
                return status, body
            if not delays:
                raise ServerUnavailable(f"{what}: {self.server} not reachable ({problem})")
            wait = delays.pop(0)
            log.warning("%s: server not reachable (%s); retrying in %s", what, problem, _fmt(wait))
            self.sleep(wait)

    def _call(self, method: str, path: str, payload: dict | None = None) -> tuple[int, bytes]:
        data = json.dumps(payload).encode() if payload is not None else b""
        headers = self.headers()
        if payload is not None:
            headers["Content-Type"] = "application/json"

        def attempt() -> tuple[int, bytes]:
            req = urllib.request.Request(self.url(path), data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.status, resp.read()
            except urllib.error.HTTPError as err:
                with err:
                    return err.code, err.read()

        return self.retrying(f"{method} {path}", attempt)

    @staticmethod
    def check_id(job_id: str) -> str:
        if not isinstance(job_id, str) or not SHORTCODE_RE.match(job_id):
            raise ApiError(0, "bad-id", f"not a shortcode: {job_id!r}")
        return job_id

    # --- the API ------------------------------------------------------------

    def claim(self) -> Job | None:
        status, body = self._call("POST", "/jobs/claim", {"name": self.name})
        if status == 204:
            return None
        if status == 409:
            raise NotWorkerMode("the server scrapes Instagram itself (instagram_source: local); no jobs for workers")
        if status != 200:
            raise parse_error(status, body)
        try:
            data = json.loads(body)
            job = Job(str(data["id"]), str(data["url"]), str(data.get("leaseUntil") or ""))
        except (ValueError, KeyError, TypeError):
            raise ApiError(status, "bad-answer", "the claim answer is not {id, url, leaseUntil}") from None
        self.check_id(job.id)
        return job

    def _expect_204(self, status: int, body: bytes) -> None:
        if status not in (200, 204):
            raise parse_error(status, body)

    def failure(self, job_id: str, reason: str, *, permanent: bool) -> None:
        path = f"/jobs/{self.check_id(job_id)}/failure"
        self._expect_204(*self._call("POST", path, {"reason": reason[:REASON_MAX], "permanent": bool(permanent)}))

    def release(self, job_id: str) -> None:
        self._expect_204(*self._call("POST", f"/jobs/{self.check_id(job_id)}/release"))

    def heartbeat(self, state: str, message: str | None = None) -> None:
        payload = {"name": self.name, "version": self.version, "state": state}
        if message:
            payload["message"] = message[:REASON_MAX]
        self._expect_204(*self._call("POST", "/worker/heartbeat", payload))


def _fmt(seconds: float) -> str:
    return f"{seconds / 60:g} min" if seconds >= 60 else f"{seconds:g} s"
