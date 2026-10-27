# karpathy-instagram-worker

Scrapes Instagram posts for a karpathy.app server from your own machine (home IP), with
[instascraper](https://github.com/tillg/instascraper): it claims one post at a time from the server's job API, scrapes
it with your Instagram session, paced like a person, and uploads the result.

**Setting one up:** [docs/instagram-worker.md](../../docs/instagram-worker.md) (prerequisites, install with pipx,
token, login, service, troubleshooting, upgrade, uninstall).

```sh
pipx install "git+https://github.com/tillg/karpathy.app@v<server version>#subdirectory=tools/instagram-worker"
karpathy-instagram-worker --help
```

## Development

- `src/karpathy_instagram_worker/`: `cli.py` (commands), `config.py` (TOML config, 0600), `client.py` (job API over
  stdlib `urllib`), `upload.py` (tar.gz, streamed `PUT`), `scrape.py` (instascraper calls, error mapping), `loop.py`
  (gate → claim → scrape → upload), `service.py` + `templates/` (launchd / systemd).
- Tests: `bash tools/instagram-worker/test.sh [-k pattern]` runs pytest in `python:3.11-slim` (the oldest supported
  Python) with instascraper and instagrapi replaced by `tests/stubs/`. Part of `just check`.
- The instascraper tag in `pyproject.toml` matches `INSTASCRAPER_REF` in `deploy/ingest/Dockerfile`; bump both together.
- Design: [`specs/changes/instagram-worker/`](../../specs/changes/instagram-worker/) (later `specs/system/`).
