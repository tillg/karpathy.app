"""Stub of instascraper.auth (v1.1.0): get_client and login_interactive_free with the real signatures."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

DEFAULT_SESSION_DIR = Path.home() / ".config" / "instascraper"
DEFAULT_GEO_PROFILE = "de"

# Set to an exception (instance) to make get_client raise it.
GET_CLIENT_RAISES: BaseException | None = None
# Every call's arguments, newest last.
GET_CLIENT_CALLS: list[dict] = []
LOGIN_CALLS: list[dict] = []
# Set to an exception to make login_interactive_free raise it.
LOGIN_RAISES: BaseException | None = None
# When set, login_interactive_free asks `code(LOGIN_ASKS_CODE_VIA)` ("SMS", "email", ...), as for 2FA.
LOGIN_ASKS_CODE_VIA: str | None = None


class FakeClient:
    username = "tester"


def get_client(session_file: str | None = None, browser: str | None = None, username: str | None = None,
               password: str | None = None, progress=None, humanizer=None, device_profile: str = "android",
               geo_profile: str = DEFAULT_GEO_PROFILE):
    GET_CLIENT_CALLS.append(dict(session_file=session_file, browser=browser, username=username, password=password,
                                 humanizer=humanizer))
    if GET_CLIENT_RAISES is not None:
        raise GET_CLIENT_RAISES
    return FakeClient(), username or os.environ.get("IG_USERNAME") or "tester"


class LoginError(Exception):
    pass


class BadPassword(LoginError):
    pass


class CodeTimeout(LoginError):
    pass


class LoginFailed(LoginError):
    pass


def login_interactive_free(username: str, password: str, code: Callable[[str], str], *,
                           session_dir: str | Path | None = None) -> str:
    entry = dict(username=username, password=password, code=code, session_dir=session_dir, code_value=None)
    LOGIN_CALLS.append(entry)
    if LOGIN_ASKS_CODE_VIA is not None:
        entry["code_value"] = str(code(LOGIN_ASKS_CODE_VIA)).strip()
    if LOGIN_RAISES is not None:
        raise LOGIN_RAISES
    spath = Path(session_dir or DEFAULT_SESSION_DIR) / f"session-{username}.json"
    spath.parent.mkdir(parents=True, exist_ok=True)
    spath.write_text("{}")
    os.chmod(spath, 0o600)
    return username
