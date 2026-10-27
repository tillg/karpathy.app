"""One post through instascraper: `get_client`, `scrape`, `write_result`, and what its errors mean for the job.

The mapping follows instascraper's own `cli.py`: not found → the post is the problem (permanent); login, challenge
or a missing session → the worker is the problem (needs-login); Instagram's rate limit → rate-limited; anything
else → a non-permanent failure. instascraper is imported lazily, so `--help`, `version` and `doctor` work even when
it is broken.
"""

from __future__ import annotations

import contextlib
import logging
import os
import sys
from pathlib import Path

REASON_MAX = 200
LOGIN_HINT = "run karpathy-instagram-worker login"

log = logging.getLogger("karpathy_instagram_worker.scrape")


class ScrapeError(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason[:REASON_MAX]
        super().__init__(self.reason)


class Permanent(ScrapeError):
    """The post can't be scraped, ever (not found, private, deleted)."""


class NeedsLogin(ScrapeError):
    """The worker's Instagram session is missing, expired or challenged."""


class RateLimited(ScrapeError):
    """Instagram asked to slow down."""


class Transient(ScrapeError):
    """Anything else; worth another try later."""


class LogProgress:
    """instascraper's progress sink, into the log instead of a terminal line."""

    def start(self, label: str) -> None:
        log.debug("%s…", label)

    def ok(self, result: str = "done") -> None:
        log.debug("  %s", result)

    def tick(self) -> None:
        pass

    def stage(self, msg: str) -> None:
        log.info("%s", msg)

    def done(self) -> None:
        pass


def ig_username() -> str | None:
    """The Instagram account: `IG_USERNAME` in instascraper's own .env (written by `login`), else the environment."""
    from instascraper import config as iconfig

    return iconfig.load_config(iconfig.CONFIG_PATH).get("IG_USERNAME") or os.environ.get("IG_USERNAME") or None


def session_path(username: str) -> Path:
    """Where instascraper keeps the account's session (auth.get_client loads it from there)."""
    from instascraper import auth

    return Path(auth.DEFAULT_SESSION_DIR) / f"session-{username}.json"


@contextlib.contextmanager
def _no_terminal():
    """stdin on /dev/null: get_client then ends with SystemExit instead of prompting for a password. A worker never
    logs in by itself (that is `login`'s job, a fresh login is a flag-risk event)."""
    saved = sys.stdin
    with open(os.devnull) as devnull:
        sys.stdin = devnull
        try:
            yield
        finally:
            sys.stdin = saved


def _status_code(exc: BaseException) -> int | None:
    for obj in (exc, getattr(exc, "response", None)):
        code = getattr(obj, "status_code", None) or getattr(obj, "code", None)
        if isinstance(code, int):
            return code
    return None


def classify(exc: BaseException) -> ScrapeError:
    import instagrapi.exceptions as igex

    if isinstance(exc, ScrapeError):
        return exc
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, (igex.MediaNotFound, igex.ClientNotFoundError)):
        return Permanent(f"not found: {detail}")
    if isinstance(exc, (igex.LoginRequired, igex.ClientLoginRequired, igex.ChallengeRequired)):
        return NeedsLogin(f"Instagram wants a login ({type(exc).__name__}): {LOGIN_HINT}")
    if isinstance(exc, (igex.PleaseWaitFewMinutes, igex.ClientThrottledError)) or _status_code(exc) == 429:
        return RateLimited(f"Instagram rate limit: {detail}")
    return Transient(detail)


def scrape_post(job_id: str, url: str, workdir: Path, *, humanizer, username: str | None) -> Path:
    """Scrape `url` into `workdir/<job_id>/` and return that directory. Raises a ScrapeError subclass."""
    from instascraper import auth, scraper, writer
    from instascraper.url import parse_shortcode

    try:
        shortcode = parse_shortcode(url)
    except ValueError as exc:
        raise Permanent(str(exc)) from None
    if shortcode != job_id:
        raise Permanent(f"the job's URL has shortcode {shortcode}, not {job_id}")

    progress = LogProgress()
    try:
        with _no_terminal():
            client, account = auth.get_client(username=username, progress=progress, humanizer=humanizer)
    except SystemExit as exc:
        log.debug("instascraper: %s", exc)  # its advice is for its own CLI; the worker's is `login`
        raise NeedsLogin(f"no usable Instagram session: {LOGIN_HINT}") from None
    except Exception as exc:
        raise classify(exc) from None

    humanizer.record("post")
    try:
        media, result = scraper.scrape(client, shortcode, url, account, progress=progress, humanizer=humanizer)
        Path(workdir).mkdir(parents=True, exist_ok=True)
        out = writer.write_result(client, media, result, str(workdir), progress=progress)
    except Exception as exc:
        raise classify(exc) from None
    return Path(out)
