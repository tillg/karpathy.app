"""The ingest service's internal endpoint: connect Instagram from the browser (Admin › Instagram, via the backend).

Routes (every request needs `Authorization: Bearer <ingest_token>`):

    GET  /instagram/status      {state, account?, via?, waitingLinks}
    POST /instagram/login       {username, password} → {state: "connected", account} | {state: "code", via}
    POST /instagram/code        {code}               → {state: "connected", account}
    POST /instagram/disconnect                       → status

States: not-connected, waiting-for-code, connected, expired. The status never logs in (a login is a flag-risk event):
`expired` means a session exists but the resolver still reports `no-session` for Instagram links in a vault's Input/.

The login runs in a worker thread (instascraper's `login_interactive_free`); when Instagram asks for a 2FA or challenge
code, the thread blocks until `POST /instagram/code` hands one over, at most `code_timeout` seconds. One pending login
at a time: a new one replaces it. The session is written to a staging dir and moved into place only on success, so a
pending login never touches a working session. The password is passed to the login once and never stored or logged.
"""

import json
import os
import queue
import shutil
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

FIRST_ANSWER_S = 90  # how long POST /login waits for the login to connect or ask for a code


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
        staging = svc.state_dir / "instagram-login" / self.username
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, mode=0o700)
        # The existing session's device ids stay stable across a reconnect.
        old = svc.session_dir / f"session-{self.username}.json"
        if old.exists():
            shutil.copy2(old, staging / old.name)
        try:
            account = svc.login(self.username, password, self._code, session_dir=staging)
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
    def __init__(self, *, token, state_dir, session_dir, vaults_dir, login, code_timeout):
        self.token = token
        self.state_dir = Path(state_dir)
        self.session_dir = Path(session_dir)
        self.vaults_dir = Path(vaults_dir)
        self.login = login
        self.code_timeout = code_timeout
        self.lock = threading.Lock()
        self.pending: _Login | None = None
        self.last_error: str | None = None

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

    def waiting_links(self):
        """Instagram links the resolver couldn't fetch for want of a session."""
        n = 0
        for index in self.vaults_dir.glob("*/Input/*/index.md"):
            try:
                text = index.read_text(encoding="utf-8")
                if not text.startswith("---"):
                    continue
                meta = yaml.safe_load(text.split("---", 2)[1]) or {}
            except Exception:  # noqa: BLE001 — a broken item is not this endpoint's problem
                continue
            for link in meta.get("unresolved_links") or []:
                if isinstance(link, dict) and "instagram.com" in str(link.get("url", "")) and link.get("reason") == "no-session":
                    n += 1
        return n

    def status(self):
        waiting = self.waiting_links()
        with self.lock:
            p = self.pending
            if p and p.thread.is_alive() and p.via:
                return {"state": "waiting-for-code", "via": p.via, "waitingLinks": waiting}
        account = self.account()
        if not account:
            return {"state": "not-connected", "waitingLinks": waiting}
        return {"state": "expired" if waiting else "connected", "account": account, "waitingLinks": waiting}

    # ---- actions: (http status, body) ----
    def _answer(self, login: _Login):
        try:
            kind, value = login.events.get(timeout=FIRST_ANSWER_S)
        except queue.Empty:
            return 504, {"error": "login-timeout", "message": "Instagram did not answer in time"}
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
            return 400, {"error": "expired-code", "message": "The code request expired: connect again"}
        return 502, {"error": "login-failed", "message": f"Instagram login failed: {type(exc).__name__}"}

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
                return 400, {"error": "expired-code", "message": "The code request expired: connect again"}
            return 409, {"error": "no-pending-login", "message": "No login is waiting for a code: connect again"}
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


def _handler(svc: Service):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # request line only; bodies (passwords) are never logged
            print(f"ingest-server: {self.command} {self.path.split('?')[0]}", flush=True)

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            if self.headers.get("Authorization", "") == f"Bearer {svc.token}" and svc.token:
                return True
            self._send(401, {"error": "unauthorized"})
            return False

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}") if n <= 10_000 else None
                return body if isinstance(body, dict) else None
            except ValueError:
                return None

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
                if not user or not pw:
                    return self._send(400, {"error": "bad-request", "message": "username and password are required"})
                return self._send(*svc.start_login(user.strip().lstrip("@"), pw))
            if self.path == "/instagram/code":
                code = text("code")
                if not code:
                    return self._send(400, {"error": "bad-request", "message": "code is required"})
                return self._send(*svc.send_code(code.strip()))
            if self.path == "/instagram/disconnect":
                return self._send(*svc.disconnect())
            self._send(404, {"error": "not-found"})

    return Handler


def make_server(*, port, token, state_dir, session_dir, vaults_dir, login, code_timeout=300.0, host="127.0.0.1"):
    svc = Service(token=token, state_dir=state_dir, session_dir=session_dir, vaults_dir=vaults_dir, login=login, code_timeout=code_timeout)
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
    srv = make_server(
        port=int(os.environ.get("INGEST_SERVER_PORT", "8090")), host="0.0.0.0", token=token,
        state_dir=Path(os.environ.get("INGEST_STATE", "/state")),
        session_dir=Path.home() / ".config" / "instascraper",
        vaults_dir=Path(os.environ.get("INGEST_VAULTS", "/vaults")), login=login,
    )
    print(f"ingest-server: listening on :{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
