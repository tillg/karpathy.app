"""Command line: `karpathy-instagram-worker <command>`.

Exit codes: 0 ok, 1 a check or the work failed (the message says why), 2 a usage or config error.
"""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys
import threading

from . import __version__, config
from .client import ApiError, JobClient, ServerUnavailable, TokenRejected

PROG = "karpathy-instagram-worker"

_DESCRIPTION = """\
Scrapes Instagram posts for your karpathy.app server, from this machine and with
your own Instagram session. The server hands out jobs (one post each); the worker
scrapes the post with instascraper, paced like a person, and uploads the result.
Nothing else leaves this machine."""

_EPILOG = f"""\
getting started:
  {PROG} configure      server URL, worker token, worker name
  {PROG} login          log in to Instagram once (session stays on this machine)
  {PROG} doctor         check everything
  {PROG} once           do one job (or find none) and exit
  {PROG} service install  run it in the background, at login

The worker token comes from the server's operator: `just instagram-worker-token
<target>` in the karpathy.app checkout. Setup guide:
https://github.com/tillg/karpathy.app/blob/main/docs/instagram-worker.md"""

log = logging.getLogger("karpathy_instagram_worker")


class UsageError(Exception):
    """A wrong argument or answer; exit 2."""


def token_rejected_text(server: str) -> str:
    return (
        f"error: {server} rejected the worker token (HTTP 401).\n"
        "  Get the current token where the server is deployed: `just instagram-worker-token <target>` in the\n"
        f"  karpathy.app checkout (dev, prodtest or hetzner), then run: {PROG} configure --token <token>\n"
        f"  (or `{PROG} configure` and paste it at the prompt)."
    )


def setup_logging(verbose: bool = False) -> None:
    """Timestamped lines on stdout: launchd and systemd capture them as the service log."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S"))
    root = logging.getLogger("karpathy_instagram_worker")
    root.handlers[:] = [handler]
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    root.propagate = False


def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        raise UsageError(f"no answer to {prompt.strip()!r} (stdin is closed); pass it as an option") from None


def cmd_configure(args) -> int:
    raw = config.load_raw()
    server = args.server or raw.get("server") or _ask("Server URL (e.g. https://karpathy.example.com): ")
    server = config.validate_server(server)
    token = args.token or raw.get("token")
    if not token:
        token = getpass.getpass("Worker token (input hidden; from `just instagram-worker-token <target>`): ").strip()
        if not token:
            raise UsageError("no worker token given")
    name = args.name or raw.get("name") or config.default_name()
    cfg = config.validate(
        config.Config(
            server=server,
            token=token,
            name=name,
            poll_interval_s=args.poll_interval or raw.get("poll_interval_s", config.DEFAULT_POLL_INTERVAL_S),
        )
    )
    # One heartbeat checks URL and token before anything is saved; no retries, so a typo answers at once.
    client = JobClient(cfg.server, cfg.token, cfg.name, backoff=())
    warning = None
    try:
        client.heartbeat("idle", "configured")
    except TokenRejected:
        print(token_rejected_text(cfg.server), file=sys.stderr)
        print("Nothing was saved.", file=sys.stderr)
        return 1
    except ServerUnavailable as exc:
        warning = f"Could not reach the server ({exc}). Saved anyway; check later with: {PROG} doctor"
    except ApiError as exc:
        warning = f"The server answered the check with {exc}. Saved anyway; check with: {PROG} doctor"
    p = config.save(cfg)
    print(f"Saved {p} (mode 0600): server {cfg.server}, worker name {cfg.name}.")
    if warning:
        print(warning)
    else:
        print("The server accepted the worker token.")
    print(f"Next: {PROG} login   (then {PROG} doctor)")
    return 0


def _instascraper_missing(exc: ImportError) -> UsageError:
    return UsageError(
        f"instascraper can't be imported ({exc}). Reinstall the worker: "
        "pipx install --force \"git+https://github.com/tillg/karpathy.app@<tag>#subdirectory=tools/instagram-worker\""
    )


def _worker():
    from . import loop, scrape

    cfg = config.load()
    try:
        username = scrape.ig_username()
    except ImportError as exc:
        raise _instascraper_missing(exc) from None
    client = JobClient(cfg.server, cfg.token, cfg.name)
    return loop.Worker(cfg, client, username=username)


def cmd_once(args) -> int:
    worker = _worker()
    step = worker.step()
    print(f"{step.state}: {step.note}")
    return 1 if step.state in ("needs-login", "rate-limited", "error") else 0


def cmd_run(args) -> int:
    from . import loop

    worker = _worker()
    log.info(
        "%s %s started: server %s, worker %s, Instagram account %s",
        PROG, __version__, worker.cfg.server, worker.cfg.name,
        f"@{worker.username}" if worker.username else "(none: run login)",
    )
    stop = threading.Event()
    worker.client.sleep = stop.wait  # a SIGTERM cuts short the server-retry backoff, not the job's own pacing
    previous = loop.install_stop_handlers(stop)
    try:
        worker.run(stop)
    finally:
        loop.restore_handlers(previous)
    return 0


def cmd_service(args) -> int:
    from . import service

    try:
        svc = service.for_platform(exe=service.command_path() if args.action == "install" else None)
        if args.action == "status":
            print(svc.status())
        else:
            for line in getattr(svc, args.action)():
                print(line)
    except service.ServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


def cmd_version(args) -> int:
    print(f"{PROG} {__version__}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog=PROG, description=_DESCRIPTION, epilog=_EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--config", metavar="PATH",
        help=f"config file (default: $KARPATHY_WORKER_CONFIG or ~/.config/{PROG}/config.toml)",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="log debug details")
    sub = p.add_subparsers(dest="command", metavar="<command>", required=True)

    c = sub.add_parser(
        "configure", help="set the server URL, worker token and worker name",
        description="Write the config. Asks for what is not given (the token without echo); keeps the values of "
        "an existing config that are not given.",
    )
    c.add_argument("--server", metavar="URL", help="the app's URL, e.g. https://karpathy.example.com")
    c.add_argument("--token", metavar="TOKEN", help="the worker token (better: leave it out and paste it at the prompt)")
    c.add_argument("--name", metavar="NAME", help="this worker's name in the app (default: the short host name)")
    c.add_argument("--poll-interval", type=int, metavar="SECONDS", help="how often to ask for a job when idle (default 60)")
    c.set_defaults(func=cmd_configure)

    o = sub.add_parser(
        "once", help="do one step (claim and scrape one job, or find none) and exit",
        description="One step of the loop, then exit: 0 when it went fine (also with no job), 1 when Instagram "
        "needs a login, rate-limits, or the job failed.",
    )
    o.set_defaults(func=cmd_once)

    r = sub.add_parser(
        "run", help="work until stopped (what the service runs)",
        description="Claim and scrape jobs until SIGTERM or Ctrl-C; the job in progress finishes first. Logs go "
        "to stdout with timestamps.",
    )
    r.set_defaults(func=cmd_run)

    s = sub.add_parser(
        "service", help="install, remove or show the background service (launchd on macOS, systemd on Linux)",
        description="install: a LaunchAgent (macOS) or systemd user unit (Linux) that runs `run` at login and "
        "restarts it; installing again replaces it (do that after an upgrade). uninstall: stop and remove it. "
        "status: whether it runs, and the last log lines.",
    )
    s.add_argument("action", choices=["install", "uninstall", "status"])
    s.set_defaults(func=cmd_service)

    v = sub.add_parser("version", help="print the version")
    v.set_defaults(func=cmd_version)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.config:
        os.environ[config.ENV_PATH] = args.config
    setup_logging(args.verbose)
    try:
        return args.func(args)
    except (config.ConfigError, UsageError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except TokenRejected:
        print(token_rejected_text(config.load_raw().get("server", "the server")), file=sys.stderr)
        return 1
    except ServerUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
