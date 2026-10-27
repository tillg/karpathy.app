"""The ingest service's Instagram endpoint (server.py), run in the ingest image's test stage:

    docker build --build-context ingest_email=<src> --target test -t karpathy-ingest:test -f deploy/ingest/Dockerfile .
    docker run --rm karpathy-ingest:test pytest /opt/ingest/test_server.py

The real server runs on a free port with real files; only instascraper's login (which would talk to Instagram) is
replaced by a scripted fake.
"""

import gzip
import io
import json
import os
import stat
import tarfile
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
    assert svc.call("GET", "/instagram/status") == (200, {"state": "not-connected", "waitingLinks": 0, "source": "local"})
    svc.call("GET", "/instagram/status")
    assert svc.fake.calls == 0


def test_login_without_code_connects(svc):
    assert svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD}) == (200, {"state": "connected", "account": "tillg"})
    assert svc.call("GET", "/instagram/status")[1]["state"] == "connected"
    assert svc.call("GET", "/instagram/status")[1]["account"] == "tillg"


def test_login_code_connected_session_0600_and_no_password_on_disk(svc):
    status, body = svc.call("POST", "/instagram/login", {"username": "twofa", "password": PASSWORD})
    assert (status, body) == (200, {"state": "code", "via": "SMS"})
    assert svc.call("GET", "/instagram/status")[1] == {"state": "waiting-for-code", "via": "SMS", "waitingLinks": 0, "source": "local"}
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
    assert svc.call("GET", "/instagram/status")[1] == {"state": "not-connected", "waitingLinks": 1, "source": "local"}
    svc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD})
    # The no-session reason is older than the new session: the resolver hasn't tried it yet.
    assert svc.call("GET", "/instagram/status")[1] == {"state": "connected", "account": "tillg", "waitingLinks": 1, "source": "local"}
    # The resolver tried again after the connect and still had no session: Instagram rejected it.
    index = write_item(svc, "mail-a", [("https://www.instagram.com/p/abc/", "no-session")])
    later = time.time() + 5
    os.utime(index, (later, later))
    assert svc.call("GET", "/instagram/status")[1] == {"state": "expired", "account": "tillg", "waitingLinks": 1, "source": "local"}


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
    assert svc.call("POST", "/instagram/disconnect") == (200, {"state": "not-connected", "waitingLinks": 0, "source": "local"})
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
    links = "".join(f"- url: {url}\n  attempts: 0\n  reason: {json.dumps(reason)}\n" for url in urls)
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


# ---- worker mode: result upload ----

def result_files(code, prefix=""):
    return {f"{prefix}post.md": b"# a post\n", f"{prefix}metadata.json": json.dumps({"shortcode": code}).encode(),
            f"{prefix}1.jpg": b"\xff\xd8 a jpeg"}


def tarball(files, extra=()):
    """A tar.gz of `files` (name → bytes) plus raw TarInfo members `extra` (links, devices, …)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
        for info in extra:
            tf.addfile(info)
    return buf.getvalue()


def put(svc, code, data=b"", headers=None):
    """A raw PUT of a result: `headers` replaces the default Content-Length; the body is sent only if given."""
    import http.client

    host, port = svc.base.split("//")[1].split(":")
    c = http.client.HTTPConnection(host, int(port), timeout=5)
    c.putrequest("PUT", f"/instagram/jobs/{code}/result")
    c.putheader("Authorization", f"Bearer {TOKEN}")
    c.putheader("Content-Type", "application/gzip")
    for k, v in (headers if headers is not None else {"Content-Length": str(len(data))}).items():
        c.putheader(k, v)
    c.endheaders()
    if data:
        c.send(data)
    r = c.getresponse()
    body = r.read()
    c.close()
    return r.status, json.loads(body) if body else {}


def results(svc):
    return svc.state / "instagram" / "results"


def leftovers(svc):
    """Everything under results/ and incoming/."""
    return sorted(str(p.relative_to(svc.state)) for d in ("results", "incoming")
                  for p in (svc.state / "instagram" / d).rglob("*"))


def test_a_valid_tarball_lands_in_results_and_the_lease_ends(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    ig_item(wsvc, "mail-b", ["https://www.instagram.com/p/BBBBB2/"], age=-10)
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert put(wsvc, "AAAAA1", tarball(result_files("AAAAA1", "AAAAA1/"))) == (204, {})
    stored = results(wsvc) / "AAAAA1"
    assert sorted(p.name for p in stored.iterdir()) == ["1.jpg", "metadata.json", "post.md"]
    assert (stored / "post.md").read_bytes() == b"# a post\n"
    assert leftovers(wsvc) == ["instagram/results/AAAAA1", *(f"instagram/results/AAAAA1/{n}" for n in ("1.jpg", "metadata.json", "post.md"))]
    # A stored result is no job any more; the next claim gets the other one.
    assert claim(wsvc)[1]["id"] == "BBBBB2"
    # A flat tarball (no <id>/ level) is fine too.
    assert put(wsvc, "BBBBB2", tarball(result_files("BBBBB2"))) == (204, {})
    assert sorted(p.name for p in (results(wsvc) / "BBBBB2").iterdir()) == ["1.jpg", "metadata.json", "post.md"]


def test_a_second_upload_of_the_same_id_is_204_and_changes_nothing(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert put(wsvc, "AAAAA1", tarball(result_files("AAAAA1"))) == (204, {})
    other = {**result_files("AAAAA1"), "post.md": b"# another\n", "2.jpg": b"x"}
    assert put(wsvc, "AAAAA1", tarball(other)) == (204, {})
    assert (results(wsvc) / "AAAAA1" / "post.md").read_bytes() == b"# a post\n"
    assert not (results(wsvc) / "AAAAA1" / "2.jpg").exists()
    assert not list((wsvc.state / "instagram" / "incoming").iterdir())


def test_an_upload_after_the_lease_lapsed_still_counts_while_the_id_is_wanted(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    wsvc.clock.advance(45 * 60)
    assert put(wsvc, "AAAAA1", tarball(result_files("AAAAA1"))) == (204, {})
    assert (results(wsvc) / "AAAAA1" / "post.md").exists()


def test_no_content_length_is_411(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert put(wsvc, "AAAAA1", headers={})[0] == 411
    status, body = put(wsvc, "AAAAA1", b"5\r\nhello\r\n0\r\n\r\n", headers={"Transfer-Encoding": "chunked"})
    assert (status, body["error"]) == (411, "length-required")
    assert leftovers(wsvc) == []


def test_content_length_600_mb_is_413_and_the_body_isnt_read(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    # No body is sent at all: a server that tried to read it would time out instead of answering.
    status, body = put(wsvc, "AAAAA1", headers={"Content-Length": str(600 * 1024 * 1024)})
    assert (status, body["error"]) == (413, "too-large")
    assert leftovers(wsvc) == []


def special(name, kind, **kw):
    info = tarfile.TarInfo(name)
    info.type = kind
    for k, v in kw.items():
        setattr(info, k, v)
    return info


@pytest.mark.parametrize("label, files, extra", [
    ("absolute path", {**result_files("AAAAA1"), "/etc/evil": b"x"}, ()),
    ("absolute path of the id dir", result_files("AAAAA1", "/AAAAA1/"), ()),
    ("..", {**result_files("AAAAA1"), "../evil": b"x"}, ()),
    ("nested ..", {**result_files("AAAAA1", "AAAAA1/"), "AAAAA1/../../evil": b"x"}, ()),
    ("symlink", result_files("AAAAA1"), [special("link.jpg", tarfile.SYMTYPE, linkname="/etc/passwd")]),
    ("hard link", result_files("AAAAA1"), [special("hard.jpg", tarfile.LNKTYPE, linkname="post.md")]),
    ("device file", result_files("AAAAA1"), [special("dev", tarfile.CHRTYPE, devmajor=1, devminor=3)]),
    ("fifo", result_files("AAAAA1"), [special("fifo", tarfile.FIFOTYPE)]),
    ("41 files", {**result_files("AAAAA1"), **{f"{i}.jpg": b"x" for i in range(10, 48)}}, ()),
    ("a name with a space", {**result_files("AAAAA1"), "my photo.jpg": b"x"}, ()),
    ("two directory levels", result_files("AAAAA1", "AAAAA1/sub/"), ()),
    ("a directory not named after the id", result_files("AAAAA1", "BBBBB2/"), ()),
    ("flat and nested mixed", {**result_files("AAAAA1"), "AAAAA1/2.jpg": b"x"}, ()),
    ("missing post.md", {k: v for k, v in result_files("AAAAA1").items() if k != "post.md"}, ()),
    ("missing metadata.json", {k: v for k, v in result_files("AAAAA1").items() if k != "metadata.json"}, ()),
    ("metadata shortcode != id", result_files("BBBBB2"), ()),
    ("metadata not JSON", {**result_files("AAAAA1"), "metadata.json": b"{nope"}, ()),
])
def test_an_invalid_result_is_422_and_nothing_is_kept(wsvc, label, files, extra):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    status, body = put(wsvc, "AAAAA1", tarball(files, extra))
    assert (status, body.get("error")) == (422, "invalid-result"), label
    assert body["message"]
    assert leftovers(wsvc) == [], label
    assert not (wsvc.tmp / "evil").exists() and not (wsvc.state / "evil").exists()


@pytest.mark.parametrize("data", [b"not a gzip at all", gzip.compress(b"not a tar"), tarball(result_files("AAAAA1"))[:-40]],
                         ids=["plain bytes", "gzip but no tar", "truncated"])
def test_not_a_gzip_tarball_is_422(wsvc, data):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    status, body = put(wsvc, "AAAAA1", data)
    assert (status, body["error"]) == (422, "invalid-result")
    assert leftovers(wsvc) == []


def test_an_id_nobody_wants_is_404(wsvc, svc):
    status, body = put(wsvc, "AAAAA1", tarball(result_files("AAAAA1")))
    assert (status, body["error"]) == (404, "unknown-job")
    assert leftovers(wsvc) == []
    # Local mode wants nothing.
    ig_item(svc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert put(svc, "AAAAA1", tarball(result_files("AAAAA1")))[0] == 404


def fail(svc, code, reason="ValueError: boom", permanent=False):
    return svc.call("POST", f"/instagram/jobs/{code}/failure", {"reason": reason, "permanent": permanent})


def marker(svc, code):
    return json.loads((results(svc) / f"{code}.failed.json").read_text())


HOUR = 3600


def test_a_permanent_failure_is_never_claimed_again(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert fail(wsvc, "AAAAA1", "MediaNotFound: gone", permanent=True) == (204, {})
    m = marker(wsvc, "AAAAA1")
    assert (m["reason"], m["permanent"], m["count"]) == ("MediaNotFound: gone", True, 1) and m["at"]
    for _ in range(3):
        wsvc.clock.advance(48 * HOUR)
        assert claim(wsvc)[0] == 204


def test_a_non_permanent_failure_is_skipped_for_count_hours_then_claimable(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert fail(wsvc, "AAAAA1") == (204, {})
    # The failure ends the lease, and the backoff (1 h after the first failure) starts.
    assert claim(wsvc)[0] == 204
    wsvc.clock.advance(HOUR - 60)
    assert claim(wsvc)[0] == 204
    wsvc.clock.advance(120)
    assert claim(wsvc)[1]["id"] == "AAAAA1"
    assert fail(wsvc, "AAAAA1") == (204, {})
    assert marker(wsvc, "AAAAA1")["count"] == 2
    wsvc.clock.advance(2 * HOUR - 60)
    assert claim(wsvc)[0] == 204
    wsvc.clock.advance(120)
    assert claim(wsvc)[1]["id"] == "AAAAA1"


def test_the_5th_non_permanent_failure_turns_permanent(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    for n in range(1, 6):
        assert claim(wsvc)[1]["id"] == "AAAAA1", n
        assert fail(wsvc, "AAAAA1", f"try {n}") == (204, {})
        assert marker(wsvc, "AAAAA1")["permanent"] is (n == 5)
        wsvc.clock.advance(25 * HOUR)
    assert marker(wsvc, "AAAAA1")["reason"] == "try 5"
    assert claim(wsvc)[0] == 204
    # Permanent stays permanent.
    assert fail(wsvc, "AAAAA1", "later", permanent=False) == (204, {})
    assert marker(wsvc, "AAAAA1")["permanent"] is True


def test_a_later_successful_upload_removes_a_non_permanent_marker(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert fail(wsvc, "AAAAA1") == (204, {})
    assert put(wsvc, "AAAAA1", tarball(result_files("AAAAA1"))) == (204, {})
    assert not (results(wsvc) / "AAAAA1.failed.json").exists()
    assert (results(wsvc) / "AAAAA1" / "post.md").exists()


def test_an_8_day_old_result_dir_and_marker_are_pruned_a_6_day_old_one_isnt(wsvc):
    def aged(path, days):
        t = wsvc.clock() - days * 24 * HOUR
        os.utime(path, (t, t))

    for code, days in (("OLD001", 8), ("NEW001", 6)):
        d = results(wsvc) / code
        d.mkdir()
        (d / "post.md").write_text("x")
        aged(d, days)
        f = results(wsvc) / f"{code[:3]}002.failed.json"
        f.write_text(json.dumps({"reason": "x", "permanent": True, "at": "2026-01-01T00:00:00Z", "count": 1}))
        aged(f, days)
    claim(wsvc)
    assert sorted(p.name for p in results(wsvc).iterdir()) == ["NEW001", "NEW002.failed.json"]
    # At most once an hour.
    late = results(wsvc) / "LATE01"
    late.mkdir()
    aged(late, 9)
    claim(wsvc)
    assert late.exists()
    wsvc.clock.advance(HOUR + 1)
    claim(wsvc)
    assert not late.exists()


def test_reason_is_cut_at_200_chars_a_non_bool_permanent_is_400(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"])
    assert fail(wsvc, "AAAAA1", "x" * 500) == (204, {})
    assert marker(wsvc, "AAAAA1")["reason"] == "x" * 200
    for body in ({"reason": "r", "permanent": "yes"}, {"reason": "r", "permanent": 1}, {"reason": "r"},
                 {"reason": 3, "permanent": False}, {"permanent": False}):
        assert wsvc.call("POST", "/instagram/jobs/AAAAA1/failure", body)[0] == 400, body
    assert marker(wsvc, "AAAAA1")["count"] == 1


def test_a_failure_for_an_id_nobody_wants_is_404(wsvc):
    status, body = fail(wsvc, "AAAAA1")
    assert (status, body["error"]) == (404, "unknown-job")
    assert fail(wsvc, "abc")[0] == 400
    assert not (results(wsvc) / "AAAAA1.failed.json").exists()


def test_a_result_with_a_bad_id_is_400(wsvc):
    assert put(wsvc, "a%2F..", tarball(result_files("AAAAA1")))[0] == 400
    assert put(wsvc, "abc", tarball(result_files("AAAAA1")))[0] == 400


# ---- worker mode: heartbeat and status ----

def heartbeat(svc, name="mac", state="idle", message=None, version="0.1.0"):
    body = {"name": name, "version": version, "state": state}
    if message is not None:
        body["message"] = message
    return svc.call("POST", "/instagram/worker/heartbeat", body)


def status(svc):
    s, body = svc.call("GET", "/instagram/status")
    assert s == 200
    return body


def test_heartbeat_records_name_version_state_message_last_seen(wsvc):
    assert heartbeat(wsvc, "mac", "needs-login", "run karpathy-instagram-worker login") == (204, {})
    assert status(wsvc)["workers"] == [{"name": "mac", "version": "0.1.0", "state": "needs-login",
                                        "message": "run karpathy-instagram-worker login",
                                        "lastSeen": server._iso(wsvc.clock())}]
    wsvc.clock.advance(60)
    assert heartbeat(wsvc, "pi", "idle") == (204, {})
    # Newest first; no message, no key.
    assert [w["name"] for w in status(wsvc)["workers"]] == ["pi", "mac"]
    assert "message" not in status(wsvc)["workers"][0]
    # A worker seen more than 30 days ago is gone.
    wsvc.clock.advance(31 * 24 * HOUR)
    heartbeat(wsvc, "pi", "idle")
    assert [w["name"] for w in status(wsvc)["workers"]] == ["pi"]


def test_an_unknown_state_or_a_bad_name_is_400(wsvc):
    for body in ({"name": "mac", "version": "1", "state": "sleeping"}, {"name": "a b", "version": "1", "state": "idle"},
                 {"name": "../x", "version": "1", "state": "idle"}, {"name": "x" * 65, "version": "1", "state": "idle"},
                 {"version": "1", "state": "idle"}, {"name": "mac", "state": "idle"},
                 {"name": "mac", "version": "1", "state": "idle", "message": 3}):
        assert wsvc.call("POST", "/instagram/worker/heartbeat", body)[0] == 400, body
    assert status(wsvc)["workers"] == []


def test_a_heartbeat_in_local_mode_is_fine(svc):
    assert heartbeat(svc) == (204, {})


def test_workers_survive_a_restart(start):
    first = start("worker")
    assert heartbeat(first, "mac", "scraping") == (204, {})
    assert (first.state / "instagram" / "workers.json").exists()
    second = start("worker")
    assert [(w["name"], w["state"]) for w in status(second)["workers"]] == [("mac", "scraping")]


def test_worker_mode_status_counts_waiting_leased_backing_off_ready_failed_by_shortcode(wsvc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/LEASE1/", "https://www.instagram.com/p/WAIT01/"], age=300)
    ig_item(wsvc, "mail-b", ["https://www.instagram.com/p/BACK01/", "https://www.instagram.com/p/READY1/",
                             "https://www.instagram.com/p/FAIL01/"], age=100)
    # The same post in another vault counts once.
    ig_item(wsvc, "mail-c", ["https://www.instagram.com/reel/WAIT01/"], vault="work")
    assert claim(wsvc)[1]["id"] == "LEASE1"
    assert fail(wsvc, "BACK01") == (204, {})
    assert fail(wsvc, "FAIL01", permanent=True) == (204, {})
    assert put(wsvc, "READY1", tarball(result_files("READY1"))) == (204, {})
    body = status(wsvc)
    assert body["source"] == "worker"
    assert body["queue"] == {"waiting": 1, "leased": 1, "backingOff": 1, "ready": 1, "failed": 1}
    assert body["waitingLinks"] == 6
    assert "expired" != body["state"]


def test_waiting_links_counts_instagram_links_whatever_their_reason(wsvc, svc):
    ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"], reason="worker")
    ig_item(wsvc, "mail-b", ["https://www.instagram.com/p/BBBBB2/"], reason="ValueError: boom")
    ig_item(wsvc, "mail-c", ["https://www.instagram.com/p/CCCCC3/", "https://example.com/x"], reason="no-session")
    assert status(wsvc)["waitingLinks"] == 3
    # Local mode keeps counting only the links that wait for a session.
    assert status(svc)["waitingLinks"] == 1


def test_worker_mode_status_never_says_expired(wsvc):
    wsvc.call("POST", "/instagram/login", {"username": "tillg", "password": PASSWORD})
    index = ig_item(wsvc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"], reason="no-session")
    later = time.time() + 5
    os.utime(index, (later, later))
    body = status(wsvc)
    assert body["state"] == "connected" and body["account"] == "tillg"


def test_local_mode_status_is_unchanged_plus_source_local(svc):
    ig_item(svc, "mail-a", ["https://www.instagram.com/p/AAAAA1/"], reason="no-session")
    heartbeat(svc)
    assert status(svc) == {"state": "not-connected", "waitingLinks": 1, "source": "local"}
