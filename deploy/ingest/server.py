"""The ingest service's internal endpoint: connect Instagram from the browser (Admin › Instagram, via the backend), and
the job API of the Instagram workers (via the backend's worker routes).

Routes (every request needs `Authorization: Bearer <ingest_token>`):

    GET  /instagram/status      {state, account?, via?, waitingLinks}
    POST /instagram/login       {username, password} → {state: "connected", account} | {state: "code", via}
    POST /instagram/code        {code}               → {state: "connected", account}
    POST /instagram/disconnect                       → status
    POST /instagram/jobs/claim  {name}               → {id, url, leaseUntil} | 204 no job | 409 not-worker-mode
    POST /instagram/jobs/<id>/release                → 204
    PUT  /instagram/jobs/<id>/result  tar.gz         → 204 | 404 unknown-job | 411 | 413 too-large | 422 invalid-result

States: not-connected, waiting-for-code, connected, expired. The status never logs in (a login is a flag-risk event):
`expired` means a session exists but the resolver still reports `no-session` for Instagram links in a vault's Input/.

The login runs in a worker thread (instascraper's `login_interactive_free`); when Instagram asks for a 2FA or challenge
code, the thread blocks until `POST /instagram/code` hands one over, at most `code_timeout` seconds. One pending login
at a time: a new one replaces it. The session is written to a staging dir and moved into place only on success, so a
pending login never touches a working session. The password is passed to the login once and never stored or logged.

Worker mode (`INGEST_INSTAGRAM_SOURCE=worker`): Instagram workers on the user's machines scrape the posts. A job is a
post's shortcode, derived on every claim from the vaults' `Input/*/index.md` `unresolved_links`, never stored, so the
same post in two vaults is one job. A claim leases the oldest wanted job (by the item's mtime) to a worker for
`LEASE_S`. Leases live in memory: a restart frees them, which is harmless. In local mode (the default) ingest-email
scrapes on the server and a claim answers 409. A worker uploads a scraped post as a tar.gz; once checked, it lands in
the dropbox `<state>/instagram/results/<shortcode>/`, where ingest-email's resolver maps it into the vault (it stays
the only writer of `Input/`). An upload is idempotent and needs no live lease.
"""

import gzip
import hmac
import json
import os
import queue
import re
import shutil
import tarfile
import tempfile
import threading
import time
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

FIRST_ANSWER_S = 90  # how long POST /login waits for the login to connect or ask for a code
# An Instagram username, never a path: it becomes part of file names.
USERNAME = re.compile(r"^(?!\.+$)[A-Za-z0-9._]{1,30}$")
# A job id is a post's shortcode: checked before it becomes part of any path.
SHORTCODE = re.compile(r"^[A-Za-z0-9_-]{5,40}$")
# ingest-email's own pattern for an Instagram post or Reel link.
SHORTCODE_IN_URL = re.compile(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")
WORKER_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
JOB_ROUTE = re.compile(r"^/instagram/jobs/(.+)/(result|failure|release)$")
SOURCES = ("local", "worker")
LEASE_S = 30 * 60
# Result uploads (untrusted): the tarball's size, its unpacked size, the files in it and their names.
MAX_RESULT = 500 * 1024 * 1024
MAX_UNPACKED = 1024 * 1024 * 1024
MAX_METADATA = 1024 * 1024
MAX_FILES = 40
FILE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
CHUNK = 1024 * 1024


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unpack(tarball: Path, staging: Path, code):
    """Unpacks an uploaded result into the empty dir `staging`, flat; returns None, or what is wrong with it.

    The members are checked before anything is written: regular files only, either all flat or all in one `<code>/`
    directory, at most MAX_FILES, safe names, a bounded unpacked size. `filter='data'` guards the extraction itself.
    Then the files the resolver needs: `post.md`, and `metadata.json` naming this shortcode."""
    try:
        with tarfile.open(tarball, mode="r:gz") as tf:
            files, shapes, total = [], set(), 0
            for m in tf:
                parts = m.name.split("/")
                if not all(FILE_NAME.match(p) and p not in (".", "..") for p in parts):
                    return f"unsafe name {m.name[:80]!r}: only [A-Za-z0-9._-], no absolute paths or '..'"
                if m.isdir():
                    if parts != [code]:
                        return f"directory {m.name[:80]!r}: at most one level, named after the shortcode"
                    continue
                if not m.isreg():
                    return f"{m.name[:80]!r} is not a regular file (no links or devices)"
                if len(parts) == 2 and parts[0] == code:
                    shapes.add("nested")
                elif len(parts) == 1:
                    shapes.add("flat")
                else:
                    return f"{m.name[:80]!r}: files go flat or in one directory named after the shortcode"
                files.append(m)
                total += m.size
                if len(files) > MAX_FILES:
                    return f"more than {MAX_FILES} files"
                if total > MAX_UNPACKED:
                    return f"more than {MAX_UNPACKED // 2**20} MB unpacked"
            if len(shapes) > 1:
                return "files both flat and in a directory"
            names = [m.name.rsplit("/", 1)[-1] for m in files]
            if len(set(names)) != len(names):
                return "a file name appears twice"
            for required in ("post.md", "metadata.json"):
                if required not in names:
                    return f"{required} is missing"
            if files[names.index("metadata.json")].size > MAX_METADATA:
                return "metadata.json is too large"
            tf.extractall(staging, members=[m.replace(name=n, deep=False) for m, n in zip(files, names)], filter="data")
    except (tarfile.TarError, EOFError, zlib.error, gzip.BadGzipFile):
        return "not a gzip tarball"
    # What landed must be exactly the checked regular files.
    if sorted(p.name for p in staging.iterdir() if p.is_file() and not p.is_symlink()) != sorted(names):
        return "unexpected entries after unpacking"
    try:
        meta = json.loads((staging / "metadata.json").read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError):
        return "metadata.json is not JSON"
    if not isinstance(meta, dict) or meta.get("shortcode") != code:
        return "metadata.json's shortcode is not this job's id"
    return None


EXPIRED_CODE = (400, {"error": "expired-code", "message": "The code request expired: connect again"})


class _Superseded(Exception):
    """A newer login replaced this one."""


class _Login:
    """One login attempt in its worker thread."""

    def __init__(self, svc, username, password):
        self.username = username
        self.codes: queue.Queue = queue.Queue()
        self.events: queue.Queue = queue.Queue()
        self.via = None
        self.cancelled = False
        self.thread = threading.Thread(target=self._run, args=(svc, password), daemon=True)
        self.thread.start()

    def _code(self, via):
        self.via = via
        self.events.put(("code", via))
        try:
            code = self.codes.get(timeout=self._timeout)
        except queue.Empty:
            raise TimeoutError("no code in time") from None
        if code is None:
            raise _Superseded()
        return code

    def _run(self, svc, password):
        self._timeout = svc.code_timeout
        # Its own staging dir per attempt: a retried login of the same account never shares it.
        root = svc.state_dir / "instagram-login"
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        staging = Path(tempfile.mkdtemp(dir=root))
        # The existing session's device ids stay stable across a reconnect.
        old = svc.session_dir / f"session-{self.username}.json"
        if old.exists():
            shutil.copy2(old, staging / old.name)
        try:
            account = svc.login(self.username, password, self._code, session_dir=staging)
            if not USERNAME.match(account):
                raise ValueError("unexpected account name")
            with svc.lock:
                if self.cancelled:
                    raise _Superseded()
                svc.session_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                src = staging / f"session-{account}.json"
                os.chmod(src, 0o600)
                os.replace(src, svc.session_dir / src.name)
                svc.remember_account(account)
            self.events.put(("connected", account))
        except Exception as exc:  # noqa: BLE001 — every outcome goes back to the waiting request
            self.events.put(("error", exc))
        finally:
            del password
            shutil.rmtree(staging, ignore_errors=True)


class Service:
    def __init__(self, *, token, state_dir, session_dir, vaults_dir, login, code_timeout, instagram_source="local", clock=time.time):
        if instagram_source not in SOURCES:
            raise ValueError(f"INGEST_INSTAGRAM_SOURCE must be one of {', '.join(SOURCES)}, not {instagram_source!r}")
        self.token = token
        self.state_dir = Path(state_dir)
        self.session_dir = Path(session_dir)
        self.vaults_dir = Path(vaults_dir)
        self.login = login
        self.code_timeout = code_timeout
        self.source = instagram_source
        self.clock = clock
        self.lock = threading.Lock()
        self.pending: _Login | None = None
        self.last_error: str | None = None
        self.leases: dict[str, tuple[str, float]] = {}  # shortcode → (worker name, lease end)
        # The dropbox ingest-email reads in worker mode, and the uploads on their way into it (same filesystem).
        self.results_dir = self.state_dir / "instagram" / "results"
        self.incoming_dir = self.state_dir / "instagram" / "incoming"
        for d in (self.state_dir / "instagram", self.results_dir, self.incoming_dir):
            d.mkdir(exist_ok=True, mode=0o700)

    # ---- state ----
    def account(self):
        env = self.session_dir / ".env"
        user = None
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("IG_USERNAME="):
                    user = line.split("=", 1)[1].strip() or None
        return user if user and (self.session_dir / f"session-{user}.json").exists() else None

    def remember_account(self, account):
        """instascraper's resolver finds the session through IG_USERNAME in its config .env."""
        env = self.session_dir / ".env"
        lines = [l for l in (env.read_text().splitlines() if env.exists() else []) if not l.startswith("IG_USERNAME=")]
        env.write_text("\n".join([*lines, f"IG_USERNAME={account}"]) + "\n")
        os.chmod(env, 0o600)

    def _unresolved(self, since=None):
        """(item mtime, link) for every `unresolved_links` entry of the vaults' Input/ items; with `since`, only of
        items written after that time."""
        for index in self.vaults_dir.glob("*/Input/*/index.md"):
            try:
                mtime = index.stat().st_mtime
                if since is not None and mtime <= since:
                    continue
                text = index.read_text(encoding="utf-8")
                if not text.startswith("---"):
                    continue
                meta = yaml.safe_load(text.split("---", 2)[1]) or {}
            except Exception:  # noqa: BLE001 — a broken item is not this endpoint's problem
                continue
            links = meta.get("unresolved_links") if isinstance(meta, dict) else None
            for link in links if isinstance(links, list) else []:
                if isinstance(link, dict):
                    yield mtime, link

    def waiting_links(self, since=None):
        """Instagram links the resolver couldn't fetch for want of a session; with `since`, only those it reported
        after that time (an item is rewritten on every resolve attempt)."""
        return sum(1 for _, link in self._unresolved(since)
                   if "instagram.com" in str(link.get("url", "")) and link.get("reason") == "no-session")

    def jobs(self):
        """Every shortcode in some item's `unresolved_links` → the oldest such item's mtime."""
        found = {}
        for mtime, link in self._unresolved():
            m = SHORTCODE_IN_URL.search(str(link.get("url", "")))
            if m and SHORTCODE.match(m.group(1)):
                found[m.group(1)] = min(mtime, found.get(m.group(1), mtime))
        return found

    def _job_state(self, code, now):
        """Caller holds the lock."""
        if (self.results_dir / code).is_dir():
            return "ready"
        lease = self.leases.get(code)
        if lease and lease[1] > now:
            return "leased"
        self.leases.pop(code, None)
        return "waiting"

    def status(self):
        waiting = self.waiting_links()
        with self.lock:
            p = self.pending
            if p and p.thread.is_alive() and p.via:
                return {"state": "waiting-for-code", "via": p.via, "waitingLinks": waiting}
        account = self.account()
        if not account:
            return {"state": "not-connected", "waitingLinks": waiting}
        # Expired: the resolver tried after this session was put in place and still had none.
        since = (self.session_dir / f"session-{account}.json").stat().st_mtime
        rejected = waiting and self.waiting_links(since) > 0
        return {"state": "expired" if rejected else "connected", "account": account, "waitingLinks": waiting}

    # ---- actions: (http status, body) ----
    def _answer(self, login: _Login):
        try:
            kind, value = login.events.get(timeout=FIRST_ANSWER_S)
        except queue.Empty:
            with self.lock:
                if self.pending is login:
                    login.cancelled = True
                    login.codes.put(None)
                    self.pending = None
            return 504, {"error": "login-timeout", "message": "Instagram did not answer in time: connect again"}
        if kind == "code":
            return 200, {"state": "code", "via": value}
        with self.lock:
            if self.pending is login:
                self.pending = None
        if kind == "connected":
            return 200, {"state": "connected", "account": value}
        return self._error(value)

    def _error(self, exc):
        from instascraper.auth import BadPassword, CodeTimeout

        if isinstance(exc, BadPassword):
            return 400, {"error": "wrong-password", "message": "Wrong username or password"}
        if isinstance(exc, (CodeTimeout, TimeoutError)):
            self.last_error = "expired-code"
            return EXPIRED_CODE
        # instascraper's LoginFailed carries instagrapi's cause as "<Type>: <message>", the password removed.
        reason = " ".join(str(exc).split())[:200] or type(exc).__name__
        if any(t in reason for t in ("ClientThrottledError", "PleaseWaitFewMinutes", "RateLimitError", "429")):
            return 429, {"error": "rate-limited",
                         "message": "Instagram is rate-limiting this server (too many requests): try again later, once"}
        return 502, {"error": "login-failed", "message": f"Instagram login failed: {reason}"}

    def start_login(self, username, password):
        with self.lock:
            if self.pending:
                self.pending.cancelled = True
                self.pending.codes.put(None)
            self.last_error = None
            login = self.pending = _Login(self, username, password)
        return self._answer(login)

    def send_code(self, code):
        with self.lock:
            login = self.pending
        if not login or not login.thread.is_alive():
            with self.lock:
                if self.pending is login:
                    self.pending = None
            # A login whose code wait ran out has ended by itself.
            expired = login is not None and not login.events.empty()
            if expired:
                kind, value = login.events.get()
                if kind == "error":
                    return self._error(value)
            if self.last_error == "expired-code":
                return EXPIRED_CODE
            return 409, {"error": "no-pending-login", "message": "No login is waiting for a code: connect again"}
        # Only answers to this code count: drop anything a timed-out request left behind.
        while not login.events.empty():
            login.events.get_nowait()
        login.codes.put(code)
        return self._answer(login)

    def disconnect(self):
        with self.lock:
            if self.pending:
                self.pending.cancelled = True
                self.pending.codes.put(None)
                self.pending = None
        for f in self.session_dir.glob("session-*.json"):
            f.unlink()
        return 200, self.status()

    # ---- worker mode: jobs ----
    def claim(self, name):
        if self.source != "worker":
            return 409, {"error": "not-worker-mode", "message": "This server scrapes Instagram itself (local mode)"}
        now = self.clock()
        jobs = self.jobs()
        with self.lock:
            for code in sorted(jobs, key=lambda c: (jobs[c], c)):
                if self._job_state(code, now) == "waiting":
                    self.leases[code] = (name, now + LEASE_S)
                    return 200, {"id": code, "url": f"https://www.instagram.com/p/{code}/", "leaseUntil": _iso(now + LEASE_S)}
        return 204, None

    def release(self, code):
        with self.lock:
            self.leases.pop(code, None)
        return 204, None

    def upload_answer(self, code):
        """What a result upload gets before its body is read: None (go ahead), or the final (status, body)."""
        if (self.results_dir / code).is_dir():
            return 204, None  # idempotent: a result is already there
        if self.source != "worker":
            return 404, {"error": "unknown-job"}
        with self.lock:
            leased = code in self.leases
        # Wanted, or leased: a late upload after a lapsed lease still counts while some item wants the post.
        if not leased and code not in self.jobs():
            return 404, {"error": "unknown-job"}
        return None

    def store_result(self, code, body, length):
        """Copies `length` bytes of `body` (a tar.gz) to a temp file, unpacks and checks it in a staging dir and moves
        that into results/<code>/. Nothing of a refused or broken upload is kept."""
        fd, tmp = tempfile.mkstemp(dir=self.incoming_dir, suffix=".tar.gz")
        staging = None
        try:
            with os.fdopen(fd, "wb") as f:
                left = length
                while left:
                    chunk = body.read(min(CHUNK, left))
                    if not chunk:
                        raise ConnectionError("the upload ended early")
                    f.write(chunk)
                    left -= len(chunk)
            staging = Path(tempfile.mkdtemp(dir=self.incoming_dir))
            problem = _unpack(Path(tmp), staging, code)
            if problem:
                return 422, {"error": "invalid-result", "message": problem}
            with self.lock:
                target = self.results_dir / code
                if not target.exists():
                    os.replace(staging, target)
                    staging = None
                self.leases.pop(code, None)
            return 204, None
        finally:
            Path(tmp).unlink(missing_ok=True)
            if staging:
                shutil.rmtree(staging, ignore_errors=True)


def _handler(svc: Service):
    class Handler(BaseHTTPRequestHandler):
        # Keep-alive: every answer sets Content-Length (or is a 204), and a request whose body wasn't read to its end
        # closes the connection, so the next request never starts inside an old body.
        protocol_version = "HTTP/1.1"
        timeout = 300  # an idle keep-alive connection doesn't hold its thread for ever

        def log_message(self, fmt, *args):  # request line only; bodies (passwords) are never logged
            print(f"ingest-server: {self.command} {self.path.split('?')[0]}", flush=True)

        def _send(self, status, body=None):
            data = b"" if status == 204 else json.dumps(body).encode()
            self.send_response(status)
            if self._unread:
                self.send_header("Connection", "close")
                self.close_connection = True
            if status != 204:
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _length(self):
            """The request's Content-Length; None if absent, -1 if unusable (chunked, not a number, negative)."""
            if self.headers.get("Transfer-Encoding"):
                return -1
            raw = self.headers.get("Content-Length")
            if raw is None:
                return None
            try:
                n = int(raw)
            except ValueError:
                return -1
            return n if n >= 0 else -1

        def _authorized(self):
            self._unread = self._length() not in (None, 0)
            if svc.token and hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {svc.token}".encode()):
                return True
            self._send(401, {"error": "unauthorized"})
            return False

        def _body(self):
            n = self._length() or 0
            if not 0 <= n <= 10_000:
                return None
            data = self.rfile.read(n)
            self._unread = len(data) != n
            try:
                body = json.loads(data or b"{}")
            except ValueError:
                return None
            return body if isinstance(body, dict) else None

        def do_GET(self):
            if not self._authorized():
                return
            if self.path == "/instagram/status":
                return self._send(200, svc.status())
            self._send(404, {"error": "not-found"})

        def do_POST(self):
            if not self._authorized():
                return
            body = self._body()
            if body is None:
                return self._send(400, {"error": "bad-request"})
            text = lambda k: body.get(k) if isinstance(body.get(k), str) and body.get(k).strip() else None  # noqa: E731
            if self.path == "/instagram/login":
                user, pw = text("username"), text("password")
                user = user.strip().removeprefix("@") if user else None
                if not user or not pw:
                    return self._send(400, {"error": "bad-request", "message": "username and password are required"})
                if not USERNAME.match(user):
                    return self._send(400, {"error": "bad-request", "message": "not an Instagram username"})
                return self._send(*svc.start_login(user, pw))
            if self.path == "/instagram/code":
                code = text("code")
                if not code:
                    return self._send(400, {"error": "bad-request", "message": "code is required"})
                return self._send(*svc.send_code(code.strip()))
            if self.path == "/instagram/disconnect":
                return self._send(*svc.disconnect())
            if self.path == "/instagram/jobs/claim":
                name = body.get("name")
                if not isinstance(name, str) or not WORKER_NAME.match(name):
                    return self._send(400, {"error": "bad-request", "message": "name must match [A-Za-z0-9._-]{1,64}"})
                return self._send(*svc.claim(name))
            job = JOB_ROUTE.match(self.path)
            if job and job.group(2) != "result":
                code = job.group(1)
                if not SHORTCODE.match(code):
                    return self._send(400, {"error": "bad-id"})
                if job.group(2) == "release":
                    return self._send(*svc.release(code))
            self._send(404, {"error": "not-found"})

        def do_PUT(self):
            if not self._authorized():
                return
            job = JOB_ROUTE.match(self.path)
            if not job or job.group(2) != "result":
                return self._send(404, {"error": "not-found"})
            code = job.group(1)
            if not SHORTCODE.match(code):
                return self._send(400, {"error": "bad-id"})
            n = self._length()
            if n is None or self.headers.get("Transfer-Encoding"):
                return self._send(411, {"error": "length-required"})
            if n < 0:
                return self._send(400, {"error": "bad-request", "message": "bad Content-Length"})
            if n > MAX_RESULT:  # refused before a byte of the body is read
                return self._send(413, {"error": "too-large", "message": f"a result is at most {MAX_RESULT // 2**20} MB"})
            early = svc.upload_answer(code)
            if early:
                self._drain(n)
                return self._send(*early)
            try:
                answer = svc.store_result(code, self.rfile, n)
            except (ConnectionError, TimeoutError):
                return self._send(400, {"error": "bad-request", "message": "the upload ended early"})
            self._unread = False
            self._send(*answer)

        def _drain(self, n):
            """Reads a body nobody needs, so the connection stays usable."""
            while n > 0:
                chunk = self.rfile.read(min(CHUNK, n))
                if not chunk:
                    return
                n -= len(chunk)
            self._unread = False

    return Handler


def make_server(*, port, token, state_dir, session_dir, vaults_dir, login, code_timeout=300.0, host="127.0.0.1",
                instagram_source="local", clock=time.time):
    svc = Service(token=token, state_dir=state_dir, session_dir=session_dir, vaults_dir=vaults_dir, login=login,
                  code_timeout=code_timeout, instagram_source=instagram_source, clock=clock)
    srv = ThreadingHTTPServer((host, port), _handler(svc))
    srv.daemon_threads = True
    return srv


def _fake_login(username, password, code, *, session_dir=None):
    """Dev stacks only (INGEST_FAKE_INSTAGRAM_LOGIN=1, compose.dev.yml): the e2e suite's login, no Instagram.
    Password `wrong` fails; user `twofa…` asks for code 000000 by SMS."""
    from instascraper.auth import BadPassword, LoginFailed

    if password == "wrong":
        raise BadPassword("Wrong username or password")
    if username.startswith("twofa") and code("SMS") != "000000":
        raise LoginFailed("wrong code")
    Path(session_dir).mkdir(parents=True, exist_ok=True)
    (Path(session_dir) / f"session-{username}.json").write_text("{}")
    return username


def main():
    token = Path(os.environ.get("INGEST_TOKEN_FILE", "/run/secrets/ingest_token")).read_text().strip()
    if os.environ.get("INGEST_FAKE_INSTAGRAM_LOGIN") == "1":
        login = _fake_login
        print("ingest-server: FAKE Instagram login (dev stack)", flush=True)
    else:
        from instascraper.auth import login_interactive_free as login
    source = os.environ.get("INGEST_INSTAGRAM_SOURCE") or "local"
    srv = make_server(
        port=int(os.environ.get("INGEST_SERVER_PORT", "8090")), host="0.0.0.0", token=token,
        state_dir=Path(os.environ.get("INGEST_STATE", "/state")),
        session_dir=Path.home() / ".config" / "instascraper",
        vaults_dir=Path(os.environ.get("INGEST_VAULTS", "/vaults")), login=login,
        instagram_source=source,
    )
    print(f"ingest-server: listening on :{srv.server_address[1]} (Instagram source: {source})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
