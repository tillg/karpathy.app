# Setting up an Instagram worker

Instagram blocks scraping from data-centre IPs, so the karpathy.app server doesn't fetch Instagram posts itself. An
**Instagram worker** does it instead: a small background service on a Mac or Linux machine with a home IP. This guide
installs one, from nothing to a running service, and covers what to do when it gets stuck.

You need about 15 minutes, the Instagram account's password (or a browser that is logged in to it), and SSH access
to the server you deploy to (to read the worker token).

## How it works

```text
 your machine (home IP, on the tailnet)                  karpathy.app server (app.karpathy.app)
 ┌────────────────────────────────────┐                 ┌──────────────────────────────────────────┐
 │ karpathy-instagram-worker run      │  1 claim        │ backend /api/ingest/instagram/*          │
 │  (launchd / systemd user service)  │ ──────────────▶ │   → ingest service: scans the vaults'    │
 │                                    │ ◀────────────── │     Input/*/index.md for Instagram links │
 │  instascraper + your IG session    │  {id, url}      │     that wait, leases one for 30 min     │
 │    scrapes the post, paced like    │                 │                                          │
 │    a person                        │  2 upload       │   → results dropbox (checked, unpacked)  │
 │                                    │ ──────────────▶ │   → ingest-email writes                  │
 │  heartbeat: idle / scraping /      │  tar.gz         │     Input/insta-<date>-<owner>-<id>/     │
 │  night / needs-login / …           │ ──────────────▶ │   → Admin › Secrets & keys › Instagram   │
 └────────────────────────────────────┘                 └──────────────────────────────────────────┘
```

- A mail with an Instagram link lands in a vault's `Input/`. While no worker has scraped the post, the link **waits**:
  it costs no retry attempts, however long it takes.
- The worker asks the server for one job at a time. A job is one post: its shortcode and
  `https://www.instagram.com/p/<shortcode>/` (Reels too). A post linked from two vaults is one job.
- It scrapes the post with [instascraper](https://github.com/tillg/instascraper), using the Instagram session on your
  machine, and uploads the result. Within about a minute the item shows up in `Input/` as an `insta-…` folder, exactly
  as a server-side scrape did before.
- The worker only makes **outbound** HTTPS calls to the server. Its token is valid only for the job routes: it can't
  read or change a vault. The Instagram session and password never leave your machine.

## Prerequisites

| What | Why / how |
|---|---|
| **macOS or Linux** | The background service is a LaunchAgent (macOS) or a systemd user unit (Linux). Any always-on box works: a Mac, a Raspberry Pi, a NAS, a home server. |
| **A home (residential) internet connection** | The whole point. A VPS or cloud machine gets blocked like the server. |
| **Tailscale, logged in to the same tailnet as the server** | Prod's proxy listens on the server's tailnet IP only; `app.karpathy.app` resolves to that `100.x.y.z` address. Check with `tailscale status`. |
| **Python ≥ 3.11** | macOS: `brew install python` (the system `python3` is too old). Debian 12, Ubuntu 24.04: the system Python is fine. Ubuntu 22.04 ships 3.10: install `python3.11` (deadsnakes PPA) and pass `--python python3.11` to pipx. |
| **pipx** and **git** | `brew install pipx git` / `sudo apt install pipx git`, then `pipx ensurepath` and open a new shell. pipx installs the worker into its own venv and puts the command on `PATH` (`~/.local/bin`). |
| **ffmpeg** (optional) | Used for Reels. `brew install ffmpeg` / `sudo apt install ffmpeg`. `doctor` only warns without it. |
| **An Instagram account** | Your existing one or a dedicated one. **One account per worker**: two workers with the same account look like one account on two devices at once, which Instagram flags. The app warns when two workers were active within an hour. |

The server must run a karpathy.app release with the worker API and be in worker mode
(`ingest.defaults.instagram_source: worker` in `deploy/settings/hetzner.yaml`). A server in local mode hands out no
jobs; the worker then just idles (see [Troubleshooting](#troubleshooting)).

## Before you start: stop the old Mac agent

If this Mac still has the old launchd agent that ran ingest-email locally, stop it and move its plist away. It
scrapes Instagram from the same account and would compete with the worker:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tillg.ingest-email.all.plist
mv ~/Library/LaunchAgents/com.tillg.ingest-email.all.plist ~/com.tillg.ingest-email.all.plist.disabled
```

If the agent isn't loaded, `launchctl bootout` prints an error; that's fine. Also
make sure no other machine runs the worker (or an `instascrape` cron job) with the same Instagram account.

## 1. Install

Install the worker from the git tag of the release the server runs:

```sh
pipx install "git+https://github.com/tillg/karpathy.app@v0.0.37#subdirectory=tools/instagram-worker"
karpathy-instagram-worker version
```

- **Which tag?** The one deployed on the server. The app shows it in admin mode › General (`Server 0.0.37`); the tag is
  that version with a `v` in front. The tags are listed on
  [GitHub](https://github.com/tillg/karpathy.app/tags). Using the server's version keeps the worker and the job API
  in step. `v0.0.37` above is an example.
- pipx pulls instascraper (the tag in `tools/instagram-worker/pyproject.toml`, the same one the server's ingest image
  uses) and instagrapi into the worker's own venv.
- On Ubuntu 22.04 add `--python python3.11`.

## 2. Get the worker token

The worker token is a deploy secret (`ingest_worker_token`), generated on the first deploy. Print it from your
karpathy.app checkout on the machine that can SSH to the server:

```sh
just instagram-worker-token hetzner
```

Targets: `hetzner` (prod: reads `/opt/karpathy.app/shared/secrets/ingest_worker_token` over `ssh ops@karpathy`),
`dev` (this checkout's dev stack, `deploy/secrets/ingest_worker_token`) and `prodtest`. It prints the token to stdout,
so you can carry it to another worker machine. Keep it private: whoever has it can claim jobs and upload results.

## 3. Configure

```sh
karpathy-instagram-worker configure --server https://app.karpathy.app --name mac-till
```

It asks for the token with hidden input (paste it there rather than passing `--token`, which ends up in your shell
history). Before saving, it sends one heartbeat to check the URL and the token:

- `The server accepted the worker token.` – done.
- `error: https://app.karpathy.app rejected the worker token (HTTP 401).` – nothing was saved; get the token again.
- `Could not reach the server (…). Saved anyway; check later with: karpathy-instagram-worker doctor` – usually Tailscale
  (see [Troubleshooting](#troubleshooting)).

| Option | Meaning |
|---|---|
| `--server URL` | The app's URL. `https://` only (`http://` only for `localhost`). Prod: `https://app.karpathy.app`. |
| `--token TOKEN` | The worker token. Leave it out to be asked without echo. |
| `--name NAME` | How this worker appears in the app. Default: the short host name. 1–64 letters, digits, `.`, `_`, `-`. |
| `--poll-interval SECONDS` | How often an idle worker asks for a job. Default 60, at least 5. |

The config is `~/.config/karpathy-instagram-worker/config.toml`, mode 0600 in a 0700 directory, because it holds the
token. Run `configure` again to change one value; it keeps the others. `--config PATH` (before the command) or
`KARPATHY_WORKER_CONFIG` points at another file.

## 4. Log in to Instagram

```sh
karpathy-instagram-worker login --username your_instagram_name
```

It asks for the password (hidden, never stored). If Instagram wants a 2FA or challenge code, it prints
`Instagram sent a verification code (…) for @your_instagram_name. Enter it:`; type the code from the SMS, e-mail or
authenticator app. This works over SSH on a headless box. On success:

```text
Logged in to Instagram as @your_instagram_name. The session is saved in /home/you/.config/instascraper (mode 0600) and never leaves this machine.
```

On a desktop you can instead import the session of a browser that is logged in to instagram.com:

```sh
karpathy-instagram-worker login --browser safari   # or chrome, brave, edge, firefox, chromium, opera, vivaldi
```

On macOS, reading Safari's (and some other browsers') cookies needs **Full Disk Access** for your terminal app (System
Settings → Privacy & Security → Full Disk Access; quit and reopen the terminal). Or use the password login.

The session lives where instascraper keeps it: `~/.config/instascraper/session-<username>.json`. `login` also
remembers the account as `IG_USERNAME` in `~/.config/instascraper/.env`, so later commands need no `--username`. A
plain `instascrape` CLI on the same machine shares that session.

Log in once. Logging in again and again is itself a red flag for Instagram; do it only when the worker reports
`needs-login`.

## 5. Check everything

```sh
karpathy-instagram-worker doctor
```

```text
ok    Python 3.12.3
ok    instascraper 1.1.0
ok    config /home/you/.config/karpathy-instagram-worker/config.toml (mode 0600), worker name mac-till
ok    server https://app.karpathy.app accepts the worker token
ok    Instagram session for @your_instagram_name
ok    ffmpeg on PATH
warn  service not installed (optional; `once` works without it)
      → run: karpathy-instagram-worker service install

All required checks passed.
```

Each failed line has a `→` hint. `doctor` exits 1 if a required check fails (`FAIL`); `warn` lines are optional.
It sends one heartbeat, so the worker shows up in the app right away.

## 6. Do one job by hand

```sh
karpathy-instagram-worker once
```

One step of the loop, then exit. The last line says what happened, for example:

| Output | Meaning |
|---|---|
| `idle: no job` | Nothing waits. Exit 0. |
| `idle: uploaded DAbC123xyz` | Scraped and uploaded one post. Exit 0. |
| `night: outside active hours 08:00–23:00` | The worker doesn't scrape at night (see [Pacing](#pacing-and-the-night-window)). Exit 0. Try again in the day. |
| `idle: the server is in local mode (instagram_source: local): it scrapes itself and has no jobs` | The server isn't in worker mode. |
| `needs-login: …` / `rate-limited: …` / `error: …` | See [Troubleshooting](#troubleshooting). Exit 1. |

Add `-v` (`karpathy-instagram-worker -v once`) for debug lines.

## 7. Run it as a service

```sh
karpathy-instagram-worker service install
```

It runs `karpathy-instagram-worker run` (the absolute path of the pipx-installed command) in the background and
restarts it when it exits (at most once a minute). Installing again replaces the service.

**macOS** – a LaunchAgent:

- `~/Library/LaunchAgents/app.karpathy.instagram-worker.plist`, label `app.karpathy.instagram-worker`, loaded with
  `launchctl bootstrap gui/<uid>`.
- Starts at login and runs while you are logged in. A Mac that sleeps doesn't scrape; jobs wait until it wakes.
- Log: `~/Library/Logs/karpathy-instagram-worker/worker.log` (`tail -f` it).

**Linux** – a systemd user unit:

- `~/.config/systemd/user/karpathy-instagram-worker.service`, enabled and started with
  `systemctl --user enable --now`.
- Log: the user journal, `journalctl --user -u karpathy-instagram-worker -f`.
- **Headless box:** user services stop when you log out and don't start at boot unless lingering is on. `service
  install` reminds you when it's off. Turn it on once:

  ```sh
  sudo loginctl enable-linger $USER
  ```

Check it any time:

```sh
karpathy-instagram-worker service status
```

It shows whether the service runs (state and PID) and the last 20 log lines. A healthy log looks like this:

```text
2026-10-27 09:12:03 INFO    karpathy-instagram-worker 0.1.0 started: server https://app.karpathy.app, worker mac-till, Instagram account @your_instagram_name
2026-10-27 09:12:04 INFO    claimed DAbC123xyz (https://www.instagram.com/p/DAbC123xyz/)
2026-10-27 09:12:31 INFO    uploading DAbC123xyz: 4 files, 12.3 MB
2026-10-27 09:12:35 INFO    uploaded DAbC123xyz
2026-10-27 09:12:35 INFO    uploaded DAbC123xyz; next step in 47 s
2026-10-27 09:13:40 INFO    no job; next step in 1 min
```

Stopping the service (`service uninstall`, `launchctl bootout`, `systemctl --user stop`) sends SIGTERM: the job in
progress finishes first (up to 5 minutes), then it exits.

## 8. Watch it in the app

Admin mode › **Secrets & keys** › **Instagram** shows, in worker mode:

- each worker with its name, when it was last seen, and its state (`idle`, `scraping`, `night`, `resting`,
  `needs-login`, `rate-limited`, `error`) with its message;
- the queue: how many posts wait, are in progress, back off after a failure, or failed for good;
- a warning when two or more workers were active within the last hour (one Instagram account per worker);
- a link back to this guide.

The Vaults list shows a notice when Instagram links wait and no worker was seen for an hour, and when a worker reports
`needs-login`.

## Pacing and the night window

The worker paces itself with instascraper's built-in defaults (`BehaviorProfile` in instascraper 1.1.0), so it reads
Instagram like a person, not a harvester. It asks the pacing **before** claiming a job, so a resting worker never holds
one.

| Rule | Default | What the worker does |
|---|---|---|
| Active hours | 08:00–23:00, **local time of the worker machine**; each edge shifts by up to 30 min, a different amount each day | Outside: state `night`, claims nothing, checks again every 30 min. |
| Between posts | 20–90 s, and in 1 of 5 cases another 30–120 s | Waits that long after each job. |
| Between API calls | 1–4 s | Inside one scrape. |
| Per session | 20 posts or 100 requests; a session ends after 30 min without activity | State `resting` with the reason (e.g. `session post ceiling reached (20)`), sleeps 30 min. |
| Per hour | 80 requests in a rolling hour | State `resting` until the window frees up (at most 30 min). |
| Per day | 50 posts or 400 requests | State `resting` (`daily post ceiling reached (50)`) until the next day. |

So a worker clears at most about 50 posts a day; a larger backlog takes several days, and that is intended. The
counters live in `~/.config/instascraper/activity-<username>.json` and survive restarts. They are shared with any
`instascrape` CLI run on the same account; while such a run holds the ledger, the worker rests.

The worker uses the defaults as they are: `humanize_*` settings in instascraper's `.env` don't change it.

## Troubleshooting

Start with `karpathy-instagram-worker doctor` and `karpathy-instagram-worker service status`.

| Symptom | Cause and fix |
|---|---|
| `server … rejected the worker token (HTTP 401)` (doctor, configure, or the log; the service then restarts every minute) | Wrong token, or the server's token was regenerated. `just instagram-worker-token <target>`, then `karpathy-instagram-worker configure` and paste it. A running service picks it up on its next restart; `service install` restarts it at once. |
| `server not reachable: … not reachable (URLError: …)` | This machine can't reach the server. `tailscale status` (logged in, same tailnet?), `tailscale ping karpathy`, then `curl -sI https://app.karpathy.app`. Also check the URL in the config. The worker retries each call after 1, 2 and 5 minutes before it gives up for that step. |
| `server … answered HTTP 404 …` → "is the server's karpathy.app new enough for workers?" | The server runs a release without the worker API. Deploy a newer one. |
| `the TLS certificate of … is not trusted by this Python` | macOS with python.org's Python: run its `Install Certificates.command`. A dev stack with Caddy's own CA: set `SSL_CERT_FILE` to that CA's root certificate (in the proxy container under `/data/caddy/pki/authorities/local/root.crt`). |
| State `needs-login` (app notice "Instagram needs a login on *name*"; log `Instagram wants a login (ChallengeRequired): run karpathy-instagram-worker login`) | The session expired or Instagram wants a challenge. The worker gives the job back and checks again every 10 min. Run `karpathy-instagram-worker login` on that machine; the service picks the new session up within 10 minutes. If Instagram asks for a challenge in the app, confirm it there first ("It was me"). |
| `no Instagram account set` / `no Instagram session for @…` | `login` never ran on this machine (or as another user than the service). Run it as the user the service runs as. |
| State `rate-limited` (`the Instagram session check failed: … (1 of 3 before asking for a login)`) | instascraper could not check the session: a network error, a rate limit or an expired session look the same from outside. The worker gives the job back and tries again in 30 min; only the third failure in a row turns into `needs-login`. Nothing to do unless it does. |
| State `rate-limited` (`Instagram rate limit: …`) | Instagram asked to slow down. The worker gives the job back and pauses 30 min by itself. If it keeps happening, the account is under suspicion: stop the service for a day, and make sure no second worker or `instascrape` uses the same account. |
| State `night` or `resting` | Normal, see [Pacing](#pacing-and-the-night-window). Nothing to do. |
| State `error` | One post failed for another reason (in the log). The server hands it out again later: 1 h after the first failure, 2 h after the second, and so on; the 5th failure gives up on the post. A post that doesn't exist or can't be accepted is given up at once. |
| Links wait but the worker says `no job` | The links wait in a backoff after failures (the app's "backing off" count), or another worker holds the lease (30 min). Check the queue counts in the app. |
| `idle: the server is in local mode …` | The server scrapes Instagram itself (`instagram_source: local`). Set `ingest.defaults.instagram_source: worker` for the target and deploy. |
| The app warns about two workers | Two workers reported within an hour. If both use the same Instagram account, `service uninstall` one of them. Two workers with two accounts are fine. |
| App notice "N Instagram links wait for a worker" | No worker was seen for an hour: the machine sleeps, is off, is off the tailnet, or the service stopped. `service status` on the worker machine. |
| `instascraper can't be imported` | A broken install. Reinstall with `pipx install --force` (see [Upgrade](#upgrade)). |
| `another instascrape run is using @…'s activity ledger` | An `instascrape` CLI run on the same account is going. The worker rests and tries again. |

## Upgrade

After the server is deployed with a new release, install the worker from the matching tag and reinstall the service:

```sh
pipx install --force "git+https://github.com/tillg/karpathy.app@v0.0.38#subdirectory=tools/instagram-worker"
karpathy-instagram-worker service install
karpathy-instagram-worker doctor
```

`service install` replaces the service and restarts it, so it runs the new code. Config and Instagram session stay.

## Uninstall

```sh
karpathy-instagram-worker service uninstall
pipx uninstall karpathy-instagram-worker
rm -r ~/.config/karpathy-instagram-worker                 # config with the worker token
rm -r ~/Library/Logs/karpathy-instagram-worker             # macOS only: the logs
```

The Instagram session (`~/.config/instascraper/session-<username>.json`), the pacing ledger and `IG_USERNAME` in
`~/.config/instascraper/.env` belong to instascraper. Remove them too if nothing else on the machine uses instascraper.
The server forgets a worker 30 days after its last heartbeat.

## Reference

| Command | What it does |
|---|---|
| `karpathy-instagram-worker configure` | Server URL, worker token, worker name, poll interval; checks the token. |
| `karpathy-instagram-worker login [--username NAME] [--browser BROWSER]` | Logs in to Instagram once; the session stays on this machine. |
| `karpathy-instagram-worker doctor` | Checks Python, instascraper, config, server + token, Instagram session, ffmpeg, service. |
| `karpathy-instagram-worker once` | One step (one job or none), then exit. |
| `karpathy-instagram-worker run` | Works until SIGTERM or Ctrl-C (what the service runs). |
| `karpathy-instagram-worker service install\|uninstall\|status` | The LaunchAgent (macOS) or systemd user unit (Linux). |
| `karpathy-instagram-worker version` | The worker's version. |

Global options go before the command: `--config PATH`, `-v`/`--verbose`. Exit codes: 0 ok, 1 a check or the work
failed, 2 a usage or config error.

| File | What |
|---|---|
| `~/.config/karpathy-instagram-worker/config.toml` | Config (server, token, name, `poll_interval_s`), mode 0600. |
| `~/.config/instascraper/session-<username>.json` | The Instagram session. |
| `~/.config/instascraper/.env` | `IG_USERNAME`, the account the worker uses. |
| `~/.config/instascraper/activity-<username>.json` | The pacing ledger. |
| `~/Library/LaunchAgents/app.karpathy.instagram-worker.plist` | macOS service. |
| `~/Library/Logs/karpathy-instagram-worker/worker.log` | macOS log. |
| `~/.config/systemd/user/karpathy-instagram-worker.service` | Linux service; log in `journalctl --user -u karpathy-instagram-worker`. |

The design is in [`specs/changes/instagram-worker/`](../specs/changes/instagram-worker/) (moved to
[`specs/system/`](../specs/system/) when the change is archived); the code in
[`tools/instagram-worker/`](../tools/instagram-worker/).
