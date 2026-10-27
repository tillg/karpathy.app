"""Test harness: the package from src/, the instascraper/instagrapi stubs from tests/stubs/, a fresh HOME per test
and a fake job API server on localhost."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "stubs"))
sys.path.insert(0, str(HERE.parent / "src"))

import instascraper.activity as _activity  # noqa: E402
import instascraper.auth as _auth  # noqa: E402
import instascraper.behavior as _behavior  # noqa: E402
import instascraper.config as _iconfig  # noqa: E402
import instascraper.scraper as _scraper  # noqa: E402

API = "/api/ingest/instagram"


@pytest.fixture(autouse=True)
def fresh_home(tmp_path, monkeypatch):
    """A new HOME and worker config path per test, and the stubs reset to "everything works"."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("KARPATHY_WORKER_CONFIG", str(home / ".config/karpathy-instagram-worker/config.toml"))
    monkeypatch.delenv("IG_USERNAME", raising=False)
    iscr = home / ".config" / "instascraper"
    monkeypatch.setattr(_iconfig, "CONFIG_DIR", iscr)
    monkeypatch.setattr(_iconfig, "CONFIG_PATH", iscr / ".env")
    monkeypatch.setattr(_activity, "CONFIG_DIR", iscr)
    monkeypatch.setattr(_activity, "OPENED", [])
    monkeypatch.setattr(_activity, "BUSY", False)
    monkeypatch.setattr(_auth, "DEFAULT_SESSION_DIR", iscr)
    monkeypatch.setattr(_auth, "GET_CLIENT_RAISES", None)
    monkeypatch.setattr(_auth, "GET_CLIENT_CALLS", [])
    monkeypatch.setattr(_auth, "LOGIN_CALLS", [])
    monkeypatch.setattr(_auth, "LOGIN_RAISES", None)
    monkeypatch.setattr(_auth, "LOGIN_ASKS_CODE_VIA", None)
    monkeypatch.setattr(_behavior, "NEXT_GATE", _behavior.GateResult(_behavior.PROCEED))
    monkeypatch.setattr(_behavior, "BUILT", [])
    monkeypatch.setattr(_scraper, "SCRAPE_RAISES", None)
    monkeypatch.setattr(_scraper, "CALLS", [])
    return home


class FakeServer:
    """The backend's job API on localhost. `script(method, path, *answers)` queues answers for a route (the last
    one repeats); an answer is `(status, body)` with body a dict (sent as JSON), bytes or None. Unscripted routes
    answer 204. Every request is recorded in `requests` as a dict with method, path, headers and body."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.answers: dict[tuple[str, str], list] = {}
        self.lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                with server.lock:
                    server.requests.append(
                        {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                    )
                    queue = server.answers.get((self.command, self.path))
                    if queue:
                        answer = queue.pop(0) if len(queue) > 1 else queue[0]
                    else:
                        answer = (204, None)
                status, payload = answer
                data = json.dumps(payload).encode() if isinstance(payload, (dict, list)) else (payload or b"")
                self.send_response(status)
                if data:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if data:
                    self.wfile.write(data)

            do_GET = do_POST = do_PUT = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def script(self, method: str, path: str, *answers) -> None:
        self.answers[(method, API + path)] = list(answers)

    def calls(self, method: str, path: str) -> list[dict]:
        return [r for r in self.requests if r["method"] == method and r["path"] == API + path]

    def json_bodies(self, method: str, path: str) -> list[dict]:
        return [json.loads(r["body"]) for r in self.calls(method, path)]

    def close(self) -> None:
        if self.httpd is None:
            return
        self.httpd.shutdown()
        self.httpd.server_close()
        self.httpd = None


@pytest.fixture
def server():
    s = FakeServer()
    yield s
    s.close()
