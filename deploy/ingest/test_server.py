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
from instascraper.auth import BadPassword, LoginFailed

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
        if username == "throttled":
            raise LoginFailed("ClientThrottledError: Status 429: Too many requests")
        if username == "challenged":
            raise LoginFailed("ChallengeRequired: challenge_required")
        if username.startswith("twofa"):
            if code("SMS") != "123456":
                raise RuntimeError("bad code")
        Path(session_dir).mkdir(parents=True, exist_ok=True)
        f = Path(session_dir) / f"session-{username}.json"
        f.write_text(json.dumps({"cookies": {"sessionid": "abc"}, "uuids": {}}))
        os.chmod(f, 0o600)
        return username


class Clock:
    """The server's clock (leases, backoff, pruning, lastSeen); starts at the real time, moves only when told."""

    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


@pytest.fixture()
def start(tmp_path):
    """Starts a server on the test's state, home and vault dirs; several calls share them (a restart)."""
    state, home, vaults = tmp_path / "state", tmp_path / "home", tmp_path / "vaults"
    for d in (state, home, vaults):
        d.mkdir(exist_ok=True)
    clock = Clock()
    servers = []

    def start_(source="local"):
        fake = FakeLogin()
        srv = server.make_server(
            port=0, token=TOKEN, state_dir=state, session_dir=home / ".config" / "instascraper",
            vaults_dir=vaults, login=fake, code_timeout=1.0, instagram_source=source, clock=clock,
        )
        servers.append(srv)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
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

        return type("Svc", (), {"call": staticmethod(call), "base": base, "fake": fake, "state": state, "home": home,
                                "vaults": vaults, "tmp": tmp_path, "clock": clock})

    yield start_
    for srv in servers:
        srv.shutdown()
        srv.server_close()


@pytest.fixture()
def svc(start):
    return start()


@pytest.fixture()
def wsvc(start):
    """A server in worker mode (INGEST_INSTAGRAM_SOURCE=worker)."""
    return start("worker")


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


def test_instagram_rate_limiting_says_so(svc):
    status, body = svc.call("POST", "/instagram/login", {"username": "throttled", "password": PASSWORD})
    assert status == 429 and body["error"] == "rate-limited"
    assert "try again later" in body["message"]


def test_other_login_failures_name_the_reason(svc):
    status, body = svc.call("POST", "/instagram/login", {"username": "challenged", "password": PASSWORD})
    assert status == 502 and body["error"] == "login-failed"
    assert "ChallengeRequired" in body["message"] and PASSWORD not in body["message"]


# ---- worker mode: jobs, claim, lease, release ----

def ig_item(svc, name, urls, *, vault="mylife", age=0, reason="worker", key="unresolved_links"):
    """An Input/ item whose `key` lists `urls`; its mtime is `age` seconds before the server's clock."""
    item = svc.vaults / vault / "Input" / name
    item.mkdir(parents=True, exist_ok=True)
    links = "".join(f"- url: {url}\n  attempts: 0\n  reason: {reason}\n" for url in urls)
    index = item / "index.md"
    index.write_text(f"---\ntitle: {name}\n{key}:\n{links}---\n# {name}\n")
    t = svc.clock() - age
    os.utime(index, (t, t))
    return index


def claim(svc, name="mac"):
    return svc.call("POST", "/instagram/jobs/claim", {"name": name})


def test_claim_in_local_mode_is_409_not_worker_mode(svc):
    ig_item(svc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    status, body = claim(svc)
    assert status == 409 and body["error"] == "not-worker-mode"


def test_claim_returns_the_shortcode_of_an_unresolved_post_or_reel_link_with_a_synthesized_p_url(wsvc):
    ig_item(wsvc, "mail-new", ["https://www.instagram.com/p/AAAAA1/?igsh=tracking"], age=100)
    ig_item(wsvc, "mail-old", ["https://instagram.com/reel/BBBBB2", "https://example.com/x"], age=200)
    status, body = claim(wsvc)
    assert status == 200
    # The oldest item first; the URL is rebuilt from the shortcode, the mail's own URL never leaves the server.
    assert body["id"] == "BBBBB2" and body["url"] == "https://www.instagram.com/p/BBBBB2/"
    assert body["leaseUntil"]
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert claim(wsvc)[0] == 204


def test_the_same_shortcode_in_two_vaults_is_one_job(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/SAME_1/"], vault="mylife")
    ig_item(wsvc, "mail-b", ["https://www.instagram.com/reel/SAME_1/"], vault="work")
    assert claim(wsvc)[1]["id"] == "SAME_1"
    assert claim(wsvc)[0] == 204


def test_a_leased_job_isnt_handed_out_again_until_the_lease_ends(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc, "mac")[1]["id"] == "AAAAA1"
    assert claim(wsvc, "pi")[0] == 204
    wsvc.clock.advance(29 * 60)
    assert claim(wsvc, "pi")[0] == 204


def test_an_expired_lease_frees_it(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc, "mac")[1]["id"] == "AAAAA1"
    wsvc.clock.advance(31 * 60)
    assert claim(wsvc, "pi")[1]["id"] == "AAAAA1"


def test_release_frees_it_at_once(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert wsvc.call("POST", "/instagram/jobs/AAAAA1/release")[0] == 204
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    # Releasing what nobody holds is fine too.
    assert wsvc.call("POST", "/instagram/jobs/ZZZZZ9/release")[0] == 204


def test_no_wanted_link_is_204(wsvc):
    assert claim(wsvc)[0] == 204
    ig_item(wsvc, "mail-a", ["https://example.com/x", "https://www.instagram.com/someprofile/"])
    assert claim(wsvc)[0] == 204


def test_a_resolved_or_failed_links_entry_is_no_job(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"], key="resolved_links")
    ig_item(wsvc, "mail-b", ["https://www.instagram.com/p/BBBBB2/"], key="failed_links")
    assert claim(wsvc)[0] == 204


def test_claim_needs_a_worker_name(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    for body in ({}, {"name": ""}, {"name": "a b"}, {"name": "../x"}, {"name": "x" * 65}, {"name": 3}):
        assert wsvc.call("POST", "/instagram/jobs/claim", body)[0] == 400, body
    assert claim(wsvc)[1]["id"] == "AAAAA1"


def test_a_bad_id_is_400_before_any_path_is_built(wsvc):
    before = sorted(p.relative_to(wsvc.state) for p in wsvc.state.rglob("*"))
    for bad in ["abcd", "x" * 41, "a%20b", "..","...%2F..", "a.b.c.d", "a/b/../c", "%2e%2e%2fstate"]:
        status, body = wsvc.call("POST", f"/instagram/jobs/{bad}/release")
        assert (status, body.get("error")) == (400, "bad-id"), bad
    assert sorted(p.relative_to(wsvc.state) for p in wsvc.state.rglob("*")) == before


def test_two_requests_on_one_keep_alive_connection_both_answer(wsvc):
    import http.client

    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    host, port = wsvc.base.split("//")[1].split(":")
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    c.request("POST", "/instagram/jobs/claim", body=json.dumps({"name": "mac"}), headers=headers)
    r = c.getresponse()
    assert r.status == 200 and json.loads(r.read())["id"] == "AAAAA1"
    c.request("GET", "/instagram/status", headers=headers)
    r = c.getresponse()
    assert r.status == 200 and "state" in json.loads(r.read())
    c.request("POST", "/instagram/jobs/AAAAA1/release", headers=headers)
    r = c.getresponse()
    assert r.status == 204 and r.read() == b""
    c.close()
