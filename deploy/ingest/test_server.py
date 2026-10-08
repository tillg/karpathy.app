"""The ingest service's Instagram endpoint (server.py), run in the ingest image's test stage:

    docker build --build-context ingest_email=<src> --target test -t karpathy-ingest:test -f deploy/ingest/Dockerfile .
    docker run --rm karpathy-ingest:test pytest /opt/ingest/test_server.py

The real server runs on a free port with real files; only instascraper's login (which would talk to Instagram) is
replaced by a scripted fake.
"""

import json
import os
import stat
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from instascraper.auth import BadPassword

import server

TOKEN = "t0ken"
PASSWORD = "s3cret-pass"


class FakeLogin:
    """Stands in for instascraper.auth.login_interactive_free: asks for a code for user `twofa`, writes a session."""

    def __init__(self):
        self.calls = 0
        self.saw_session_dir = None

    def __call__(self, username, password, code, *, session_dir=None):
        self.calls += 1
        self.saw_session_dir = Path(session_dir)
        if password == "wrong":
            raise BadPassword("Wrong username or password")
        if username.startswith("twofa"):
            if code("SMS") != "123456":
                raise RuntimeError("bad code")
        Path(session_dir).mkdir(parents=True, exist_ok=True)
        f = Path(session_dir) / f"session-{username}.json"
        f.write_text(json.dumps({"cookies": {"sessionid": "abc"}, "uuids": {}}))
        os.chmod(f, 0o600)
        return username


@pytest.fixture()
def svc(tmp_path):
    state, home, vaults = tmp_path / "state", tmp_path / "home", tmp_path / "vaults"
    for d in (state, home, vaults):
        d.mkdir()
    fake = FakeLogin()
    srv = server.make_server(
        port=0, token=TOKEN, state_dir=state, session_dir=home / ".config" / "instascraper",
        vaults_dir=vaults, login=fake, code_timeout=1.0,
    )
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def call(method, path, body=None, token=TOKEN):
        req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode())
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    yield type("Svc", (), {"call": staticmethod(call), "base": base, "fake": fake, "state": state, "home": home, "vaults": vaults, "tmp": tmp_path})
    srv.shutdown()


def no_password_under(root: Path) -> bool:
    return all(PASSWORD.encode() not in p.read_bytes() for p in root.rglob("*") if p.is_file())


def test_requests_need_the_token(svc):
    assert svc.call("GET", "/instagram/status", token=None)[0] == 401
    assert svc.call("GET", "/instagram/status", token="nope")[0] == 401
    assert svc.call("POST", "/instagram/login", {"username": "x", "password": PASSWORD}, token=None)[0] == 401
    assert svc.fake.calls == 0


def test_not_connected_at_first_and_status_never_logs_in(svc):
    assert svc.call("GET", "/instagram/status") == (200, {"state": "not-connected", "waitingLinks": 0})
    svc.call("GET", "/instagram/status")
    assert svc.fake.calls == 0


def test_login_without_code_connects(svc):
    assert svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD}) == (200, {"state": "connected", "account": "tillg"})
    assert svc.call("GET", "/instagram/status")[1]["state"] == "connected"
    assert svc.call("GET", "/instagram/status")[1]["account"] == "tillg"


def test_login_code_connected_session_0600_and_no_password_on_disk(svc):
    status, body = svc.call("POST", "/instagram/login", {"username": "twofa", "password": PASSWORD})
    assert (status, body) == (200, {"state": "code", "via": "SMS"})
    assert svc.call("GET", "/instagram/status")[1] == {"state": "waiting-for-code", "via": "SMS", "waitingLinks": 0}
    # While the login waits, no session file of that account is in place: the resolver sees no session.
    assert not (svc.home / ".config" / "instascraper" / "session-twofa.json").exists()
    assert svc.call("POST", "/instagram/code", {"code": "123456"}) == (200, {"state": "connected", "account": "twofa"})
    session = svc.home / ".config" / "instascraper" / "session-twofa.json"
    assert session.exists()
    assert stat.S_IMODE(session.stat().st_mode) == 0o600
    # instascraper's resolver finds the account through IG_USERNAME in its config.
    assert "IG_USERNAME=twofa" in (svc.home / ".config" / "instascraper" / ".env").read_text()
    assert no_password_under(svc.tmp)


def test_wrong_password(svc):
    status, body = svc.call("POST", "/instagram/login", {"username": "tillg", "password": "wrong"})
    assert status == 400 and body["error"] == "wrong-password"
    assert svc.call("GET", "/instagram/status")[1]["state"] == "not-connected"


def test_a_second_login_replaces_a_pending_one(svc):
    assert svc.call("POST", "/instagram/login", {"username": "twofa1", "password": PASSWORD})[1]["state"] == "code"
    assert svc.call("POST", "/instagram/login", {"username": "twofa2", "password": PASSWORD})[1]["state"] == "code"
    assert svc.call("POST", "/instagram/code", {"code": "123456"}) == (200, {"state": "connected", "account": "twofa2"})
    assert not (svc.home / ".config" / "instascraper" / "session-twofa1.json").exists()


def test_code_after_the_timeout_is_expired(svc):
    assert svc.call("POST", "/instagram/login", {"username": "twofa", "password": PASSWORD})[1]["state"] == "code"
    time.sleep(1.5)
    status, body = svc.call("POST", "/instagram/code", {"code": "123456"})
    assert status == 400 and body["error"] == "expired-code"
    assert svc.call("GET", "/instagram/status")[1]["state"] == "not-connected"


def test_code_without_a_login(svc):
    status, body = svc.call("POST", "/instagram/code", {"code": "1"})
    assert status == 409 and body["error"] == "no-pending-login"


def test_bad_bodies(svc):
    assert svc.call("POST", "/instagram/login", {"username": "x"})[0] == 400
    assert svc.call("POST", "/instagram/code", {})[0] == 400
    assert svc.call("GET", "/nope")[0] == 404


def write_item(svc, name, reasons):
    item = svc.vaults / "mylife" / "Input" / name
    item.mkdir(parents=True, exist_ok=True)
    links = "".join(f"- url: {url}\n  attempts: 1\n  reason: {reason}\n" for url, reason in reasons)
    (item / "index.md").write_text(f"---\ntitle: a\nunresolved_links:\n{links}---\n# a\n")
    return item / "index.md"


def test_waiting_links_and_expired(svc):
    write_item(svc, "mail-a", [
        ("https://www.instagram.com/p/abc/", "no-session"),
        ("https://www.instagram.com/reel/def/", "night-block"),
        ("https://example.com/x", "no-session"),
    ])
    assert svc.call("GET", "/instagram/status")[1] == {"state": "not-connected", "waitingLinks": 1}
    svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD})
    # The no-session reason is older than the new session: the resolver hasn't tried it yet.
    assert svc.call("GET", "/instagram/status")[1] == {"state": "connected", "account": "tillg", "waitingLinks": 1}
    # The resolver tried again after the connect and still had no session: Instagram rejected it.
    index = write_item(svc, "mail-a", [("https://www.instagram.com/p/abc/", "no-session")])
    later = time.time() + 5
    os.utime(index, (later, later))
    assert svc.call("GET", "/instagram/status")[1] == {"state": "expired", "account": "tillg", "waitingLinks": 1}


def test_the_resolver_finds_the_account(svc):
    from instascraper.config import load_config

    svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD})
    assert load_config(svc.home / ".config" / "instascraper" / ".env")["IG_USERNAME"] == "tillg"


def test_usernames_that_are_paths_are_refused(svc):
    victim = svc.state / "keep"
    victim.mkdir()
    (victim / "f").write_text("x")
    for name in ["../keep", "../../state/keep", "a/b", "..", ".", "x" * 31, "a b"]:
        status, body = svc.call("POST", "/instagram/login", {"username": name, "password": PASSWORD})
        assert status == 400, name
    assert svc.fake.calls == 0
    assert (victim / "f").exists()


def test_a_negative_content_length_is_refused(svc):
    import http.client

    host, port = svc.base.split("//")[1].split(":")
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.putrequest("POST", "/instagram/code")
    c.putheader("Authorization", f"Bearer {TOKEN}")
    c.putheader("Content-Length", "-1")
    c.endheaders()
    assert c.getresponse().status == 400


def test_disconnect(svc):
    svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD})
    assert svc.call("POST", "/instagram/disconnect") == (200, {"state": "not-connected", "waitingLinks": 0})
    assert not list((svc.home / ".config" / "instascraper").glob("session-*.json"))
