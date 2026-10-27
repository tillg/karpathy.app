"""Command line: `karpathy-instagram-worker <command>`.

Exit codes: 0 ok, 1 a check or the work failed (the message says why), 2 a usage or config error.
"""

from __future__ import annotations

import argparse
import getpass
import logging
import os
import sys

from . import __version__, config

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
    p = config.save(cfg)
    print(f"Saved {p} (mode 0600): server {cfg.server}, worker name {cfg.name}.")
    print(f"Next: {PROG} login   (then {PROG} doctor)")
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
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
