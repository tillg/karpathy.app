# Deploying karpathy.app

Everything that runs the app: the compose stack, its images, the release workflow and the Ansible
playbook that puts a release on a server. The design and its decisions are in
[`specs/system/deployment.md`](../specs/system/deployment.md); this page is the how-to.

## What runs on the server

```mermaid
flowchart TB
  subgraph Devices["Your devices (on the tailnet)"]
    iPad[iPad / iPhone / Mac<br/>karpathy.app PWA]
    Phone[Phone: ntfy app]
  end
  subgraph Server["Hetzner server karpathy (Ubuntu 24.04), reachable only via Tailscale"]
    subgraph App["compose project karpathy-app"]
      proxy[proxy: Caddy<br/>tailnet IP :443, TLS, PWA]
      backend[backend: Node<br/>vaults, git, chat API]
      opencode[opencode<br/>AI agent loop]
      egress[egress: Squid<br/>public destinations only]
      ingest[ingest: ingest-email<br/>mail + links into Input/]
    end
    subgraph Mon["compose project karpathy-monitoring"]
      hub[Beszel hub<br/>tailnet IP :8090]
      agent[Beszel agent<br/>host metrics, containers]
      gatus[Gatus<br/>tailnet IP :8091]
    end
    vaults[(/srv/vaults<br/>git clones, own filesystem)]
    timer[heartbeat timer<br/>every 5 min]
  end
  GitHub[(GitHub<br/>vault repos)]
  LLM[OpenRouter<br/>LLM]
  HC[healthchecks.io]
  NTFY[ntfy.sh]
  iPad -->|HTTPS + token| proxy
  proxy -->|/api| backend
  backend --> opencode
  backend --> vaults
  opencode --> vaults
  backend -->|clone, pull, push| GitHub
  opencode --> egress
  ingest --> vaults
  ingest --> egress
  egress -->|model calls, web search and fetch| LLM
  agent --> hub
  gatus -->|checks HTTPS + cert| proxy
  hub -->|alerts| NTFY
  gatus -->|alerts| NTFY
  timer -->|ping or /fail| HC
  HC -->|server gone or failing| NTFY
  NTFY --> Phone
```

The app and the monitoring are separate compose projects, so a deploy of the app never restarts the
monitoring that watches it. healthchecks.io sits outside the server: it is the only part that notices
when the whole box is gone.

## How it works

```
 git tag v0.3.0 ──► GitHub Actions (release.yml)
                     checks → images for amd64 + arm64 → GHCR
                     GitHub release v0.3.0 with compose.yml attached
                                       │
 Mac: just deploy hetzner 0.3.0 ──► Ansible (deploy/ansible) ──ssh──► server
                                       downloads compose.yml, pulls the images,
                                       starts the stack, runs the smoke check
```

- **A release** is a tag `vX.Y.Z` (or a pre-release `vX.Y.Z-rc.N`). CI builds the five images
  (`ghcr.io/tillg/karpathy.app-{proxy,backend,opencode,egress,ingest}:X.Y.Z`, public; the ingest image's build checks
  out the private `tillg/ingest_email` with a read-only deploy key, repo secret `INGEST_EMAIL_DEPLOY_KEY`) and attaches
  `compose.yml` to the GitHub release. Nothing is ever built on a server, and the server holds no
  copy of the source.
- **A deployment** is one `just deploy <target> [version]`. The playbook brings the host to the
  desired state (users, SSH hardening, Docker, the vaults filesystem, Tailscale), switches it to
  the release and ends with a **smoke check**: all containers healthy, `/api/health` reachable
  through the proxy, and it reports the requested version. A new version on the target is then
  announced on its ntfy topic ("karpathy-hetzner: v0.0.26 deployed"). Running it again changes nothing.
- **Rollback** is a deployment of an older version. Each release's `compose.yml` stays on the
  host under `/opt/karpathy.app/releases/`, and `current` points at the running one.
- **Monitoring** is deployed with the app as its own compose project: Beszel (host and container
  metrics, disk/memory/container alerts), Gatus (HTTPS and certificate expiry) and a heartbeat
  every 5 minutes to healthchecks.io, which raises the alert when the server is gone. All alerts go
  to the phone via ntfy.

## Where it runs

| Stack | URL | What it's for | Start |
|---|---|---|---|
| **dev** stack N (1–9) | https://localhost:80N0 | Working on the code: sources bind-mounted, hot reload, production's OpenRouter models; one per checkout, side by side (`just dev stacks`) | `just dev up [N]` |
| **prodtest** | https://localhost:80N5 | The prod images built from the working tree, paired with dev stack N | `just prodtest` |
| **hetzner** target | https://app.karpathy.app | Production: Hetzner server, reachable only over Tailscale | `just deploy hetzner` |

dev and prodtest run on a dev host: the Mac's Docker (Rancher Desktop) or the remote dev host
`karpathy-dev` ([Dev server](#dev-server)). The target is a real Ubuntu host managed by Ansible.

## The `just` recipes

`just` alone lists them all.

**Develop and test**

| Recipe | Does |
|---|---|
| `just install` | `npm install` for the workspace (after a clone or in a fresh worktree). |
| `just dev [up [N]\|down\|logs\|ps\|token\|stacks]` | This checkout's dev stack N on :80N0 (`up` without N: the remembered one, else the first free); `stacks` lists who owns which stack; `token` prints the access token. |
| `just check` | Lint, typecheck, the unit + integration tests and the dev-stack tooling tests, including `ansible/dev.test.sh` (the dev server playbook against a privileged Ubuntu container: a few minutes, needs the internet). |
| `just test [args]` | The unit + integration tests only. |
| `just e2e [args]` | Playwright against this checkout's dev stack. |
| `just prodtest [up\|down\|e2e]` | The prod images on :80N5 (paired with dev stack N), and the e2e suite against them. |
| `just resume [args]` | Continues this checkout's last Claude Code session (`claude --continue`), e.g. after reconnecting to the dev server. |
| `just devhost [--check] [--bootstrap <public-ip>]` | Sets up the remote dev host `karpathy-dev` with `ansible/dev.yml` ([Dev server](#dev-server)); `--check` is a dry run. |

**Release and deploy**

| Recipe | Does |
|---|---|
| `just release 0.3.0` | Tags `v0.3.0` on HEAD and pushes it; prints the workflow run. Refuses a dirty tree, and a final version unless HEAD is on `main` (`0.3.0-rc.1` may come from any commit). |
| `just deploy <target> [version]` | Deploys a release (default: the newest final release). Log in `tmp/deploy-<target>-*.log`. |
| `just deploy <target> [version] --only app` | Only the app role (or `--only monitoring`); assumes a full deploy ran before. The fast path for upgrades and rollbacks. |
| `just deploy hetzner --bootstrap <public-ip>` | The first run against a fresh server: as `root` on its public IP. Every later run goes as `ops` over Tailscale. |
| `just deploy-check <target> [version] [--only app\|monitoring]` | Dry run with diff; changes nothing. Needs a host that was deployed before (a fresh one has no Docker or Tailscale to check against). |

**Secrets and logging in**

| Recipe | Does |
|---|---|
| `just secrets <target>` | Fills the target's encrypted vault interactively: asks for what only you have (hidden input, Enter keeps the current value) and generates the rest once (access token, Beszel secrets, ntfy topic). Run it in your own terminal. |
| `just token <target>` | Copies the target's access token to the clipboard. |
| `just token <target> --qr` | Also prints a QR code of the login link `<app url>/#token=…`: scan it on the iPad or phone and the app opens, logged in. The QR code is a credential: don't screenshot or share it. |
| `just ingest-auth <target> <email>` | Gives the target's ingest service Gmail access: pipes this Mac's gog OAuth client (`gog auth credentials`) and the account's refresh token (Keychain, from `gog auth add <email>`) into its container. Nothing is printed or stored on the way. `dev` = this checkout's dev stack. |
| `just ntfy-topic <target>` | Copies the target's ntfy alert topic to the clipboard, to subscribe to it in the ntfy app (and in healthchecks.io's ntfy and webhook integrations, see below). `dev` copies the dev-progress topic (`karpathy-development-…`, Keychain item `karpathy-ntfy-dev`; agents post progress there, never on the alert topics). Without a Keychain (the dev server) it reads `tmp/.ntfy_dev_topic`, and without a clipboard it prints the topic. |

**Operations**

| Recipe | Does |
|---|---|
| `just hetzner-watch install\|uninstall\|now` | Checks at 08:00 and 14:00 whether a cheaper Hetzner server (CX23, CAX11) can be booked again and pushes to ntfy when it can. Needs a read-only Hetzner API token in the Keychain (`karpathy-hetzner-api`). |

## Settings

A target's app settings (model and gateway, domain and TLS, timezone, commit author, web caps) are
`settings/settings.yaml` plus `settings/<target>.yaml` (see the main README, *Settings*); `just settings show
<target>` prints them. `just deploy` renders them on this Mac with the target's secrets and copies the result
to `shared/` (`.env`, `opencode.env` with the provider config, `settings.json`). The inventory keeps only
what configures the host (Tailscale, disk size, monitoring, `domain` for the monitoring, which must equal
the settings' `proxy.domain`).

## Secrets

Each target has its own encrypted Ansible Vault,
`ansible/inventories/<target>/group_vars/all/vault.yml`, committed to git. Its password is in the
macOS Keychain as `karpathy-ansible-<target>`; keep a copy in your password manager. On a new Mac:

```sh
security add-generic-password -a "$USER" -s karpathy-ansible-hetzner -w   # prompts for the password
```

The access token is a fixed value in the vault, not generated at startup; it changes only when you
change it in the vault (and the next deploy restarts the stack with it).

### The GitHub token

The app uses **one** GitHub token for every vault: to check a repo when you add it, and to clone, pull and push.
It comes from the app's **Settings → GitHub** if one is set there, otherwise from the `GITHUB_TOKEN` secret that
`just secrets <target>` asks for. Use a **fine-grained personal access token** that can reach only the vault repos.

**Create it** at GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
(<https://github.com/settings/personal-access-tokens>) → **Generate new token**:

| Field | Value |
|---|---|
| Token name | e.g. `karpathy.app hetzner` (one token per target) |
| Resource owner | the account that owns the vault repos |
| Expiration | your choice; the app's **Test token** shows the expiry date |
| Repository access | **Only select repositories**: every repo you use as a vault |
| Permissions → Repository permissions | **Contents: Read and write** (Metadata: read-only is added by GitHub) |

Then paste it in the app (**Settings → GitHub → Save token**, takes effect on the next git operation, no restart)
or put it in the vault with `just secrets <target>` and deploy.

**Every new vault repo must be added to the token.** Before you add a vault in the app (or right after you
created its repo), edit the token: Fine-grained tokens → the token → **Edit** → Repository access → add the repo
→ **Update**. The token's value doesn't change, so nothing needs to be re-entered in the app.

**Why this is easy to miss:** a fine-grained token can *read* every public repo, also ones it wasn't given. So a
public repo that isn't on the token's list attaches, clones and passes **Test token** (which checks read access
only) — and then **Commit & Push** fails with:

```text
remote: Permission to <owner>/<repo>.git denied to <user>.
… The requested URL returned error: 403
```

The commit stays local ("1 unpushed commit · retry"); add the repo to the token and press **retry**. A private
repo that isn't on the list fails earlier, already when you add the vault: the form shows git's error
(GitHub answers "Repository not found" rather than revealing that the repo exists).

**Renaming a repo** on GitHub keeps it on the token's list (GitHub tracks the repo, not its name), but update the
vault's repo name in the app (vault details → Edit vault) so it doesn't rely on GitHub's redirect.

**When it expires,** git operations fail with 401 and **Test token** says "GitHub rejected the token (401)":
regenerate the token on the same page (**Regenerate token**, same repos and permissions) and save the new value in
the app.

## A new server, start to finish

1. Book it (Ubuntu 24.04, your SSH key, firewalls `no-inbound` + `setup-ssh`, backups on) and note
   its public IP. Background: [prod-env report §8](../specs/research/prod-env/prod-env-report.md#guide)
   (its steps 8.3–8.10 are what the playbook does).
2. In the Tailscale admin console, add `tag:server` to `tagOwners` and create an auth key: tagged
   `tag:server`, pre-approved, single-use.
3. `just secrets hetzner`: GoDaddy key, GitHub token, OpenRouter key, the Tailscale key, the
   healthchecks.io ping URL, the git author. Subscribe to the printed ntfy topic on your phone.
   In healthchecks.io, give the check two integrations to that topic: ntfy for DOWN (priority for up
   events: Disabled), and a webhook for UP that names the running version: up URL
   `https://ntfy.sh/<topic>`, POST, headers `Title: $NAME is UP` and `Tags: green_circle`, body
   `We are up again: $BODY` (the heartbeat's ping body is `version X.Y.Z`); down URL empty.
4. `just deploy hetzner --bootstrap <public-ip>`. At the end root login is off and the server is
   on the tailnet as `karpathy`; you and Ansible log in as `ops` (sudo); `deploy`, the app's own
   user (uid 1000), has no login.
5. In GoDaddy, point `app.karpathy.app` (A record) at the server's tailnet IP (`100.x.y.z`).
6. Detach the `setup-ssh` firewall in Hetzner: from now on no port is open to the internet.
7. `just deploy hetzner` again (over Tailscale) to see it report `changed=0`, then
   `just token hetzner --qr` and scan it on the iPad.

## Rebuilding the server

For a replacement server (a cheaper type, a broken box, a fresh start). The vaults live in GitHub, so
commit and push everything first; only uncommitted changes would be lost.

1. Book the new server as in step 1 above, with **`setup-ssh` attached** again.
2. Tailscale admin console → Machines: **delete the old `karpathy`**, or the new one comes up as
   `karpathy-1` (the playbook stops with that message).
3. Create a **new auth key** (the old one is used up) and put it in: `just secrets hetzner` (only
   the Tailscale prompt needs input; Enter keeps the rest).
4. `ssh-keygen -R karpathy`: the new server has a new host key under the old name.
5. `just deploy hetzner <version> --bootstrap <new-public-ip>` (it forgets the old host key of that
   IP by itself).
6. Point the A record at the new tailnet IP and detach `setup-ssh`, as in steps 5–6 above.
7. Delete the old server in Hetzner.

Each fresh server requests a new certificate; Let's Encrypt allows 5 for the same name per week.

## Dev server

`karpathy-dev` is a remote dev host: our own always-on Hetzner server, separate from prod, reached only over
Tailscale. It is a dev host like the Mac: `just dev up`, `just check`, `just e2e` and `claude` work there in several
worktrees at once, with the same stack rules (stacks 1–9, one per checkout). Its stacks open on the Mac at
`https://localhost:80N0` through SSH port forwards. The playbook is `ansible/dev.yml`: roles `base`, `tailscale`,
`docker` (shared with prod) and `devtools` (Node 22, `just`, ripgrep, jq, netcat, `gh`, the Claude Code CLI,
Playwright's Chromium). Your login has uid 1000 (sudo, docker) and there is no `deploy` user. It holds no prod data.

**Setting it up:**

1. Book it in the Hetzner console: **CAX41** (ARM, 16 vCPU, 32 GB), Ubuntu 24.04, your SSH key, firewalls
   `no-inbound` + `setup-ssh`, **backups on** (it holds uncommitted work). Note its public IP.
2. Tailscale admin console: create an auth key tagged `tag:server`, pre-approved, single-use.
3. Create a fine-grained GitHub token for `karpathy.app`, `karpathy_demo_wiki` and `ingest_email` (Contents
   read/write; Pull requests read/write if agents should open PRs).
4. `just secrets dev`: the OpenRouter key, the Exa key (optional), the GitHub token, the Tailscale key. The vault's
   password is the Keychain item `karpathy-ansible-dev` (keep a copy in your password manager).
5. `just devhost --bootstrap <public-ip>`. At the end root login is off and the server is on the tailnet as
   `karpathy-dev`; you log in as yourself (`admin_user` in `ansible/inventories/dev/group_vars/all/main.yml`, keys in
   `ansible/keys/dev.pub`). The keys land in `~/.config/karpathy/secrets/` (the host secrets every checkout falls back
   to) and the GitHub token in your git credentials.
6. Detach the `setup-ssh` firewall: from now on no port is open to the internet.
7. `just devhost` again (over Tailscale) to see it report `changed=0`. Later runs keep it up to date; `--check` shows
   what would change.

**Connecting:** add this to the Mac's `~/.ssh/config`, then `ssh karpathy-dev` (or VS Code › Remote-SSH ›
`karpathy-dev`):

```
Host karpathy-dev
  HostName karpathy-dev
  ServerAliveInterval 30
  LocalForward 8010 localhost:8010
  LocalForward 8020 localhost:8020
  LocalForward 8030 localhost:8030
  LocalForward 8040 localhost:8040
  LocalForward 8050 localhost:8050
  LocalForward 8060 localhost:8060
  LocalForward 8070 localhost:8070
  LocalForward 8080 localhost:8080
  LocalForward 8090 localhost:8090
```

On the server, once: `git clone https://github.com/tillg/karpathy.app`, `just install`, `claude` and log in with the
subscription (the project plugins install in the first session). Then `just dev up`, and open
`https://localhost:8010` on the Mac. After a reconnect, `just resume` continues the last Claude session.

**Staying connected:** `herdr --remote karpathy-dev` (or `tmux` on the server) keeps `claude` and test runs alive when
SSH drops; a bare SSH shell takes them down with it. Daily routine, ports, troubleshooting:
[docs/dev-server.md](../docs/dev-server.md).

- **One dev host at a time:** a Mac dev stack on the same port blocks that `LocalForward` (ssh warns "bind: Address
  already in use"). Stop the Mac's stacks (`just dev down`) before you connect, or the other way round.
- **Host secrets:** `just dev up` copies each `*_api_key` missing in a checkout's `deploy/secrets/` from
  `~/.config/karpathy/secrets/`, so new worktrees need no keys. A checkout's own key wins. This works on the Mac too:
  put your keys there once.
- **arm64:** like the Mac. `just prodtest` there tests the arm64 images; CI and the release build cover amd64.
- **No monitoring:** automatic security updates come from `base`; an outage shows when you connect.

## Where things are

```
deploy/
  compose.yml              the stack (one definition for dev, prodtest and every target)
  compose.dev.yml          dev overrides (bind mounts, model relay, Vite)
  compose.prodtest.yml     prodtest overrides
  dev.sh                   behind `just dev`
  backend/ proxy/ opencode/ web/   Dockerfiles and their config (Caddyfile, opencode.json)
  ansible/                 the playbooks: site.yml (targets), dev.yml (dev server), roles/, inventories/hetzner/ and dev/,
                           deploy.sh (just deploy), fill_vault.py (just secrets), token.sh (just token)
  devhost.sh               behind `just devhost`
  hetzner-watch/           the availability check behind `just hetzner-watch`
```

On a target: the app in `/opt/karpathy.app` (`releases/`, `current`, `shared/` with the rendered
settings and the secrets), monitoring in `/opt/karpathy-monitoring`, the vaults on the loop-mounted `/srv/vaults`.

## When something goes wrong

- **A deploy fails:** the log is in `tmp/deploy-<target>-*.log`; the failing task is the last
  `TASK [...]` before `fatal:`. Tasks that handle secrets show `censored`; rerun that one task
  without `no_log` only if you have to, and never paste its output anywhere.
- **The smoke check fails:** the new release is running but unhealthy. Deploy the previous
  version (`just deploy <target> <previous> --only app`) and look at the containers:
  `ssh ops@karpathy docker compose -p karpathy-app ps` and `… logs backend`.
- **Monitoring:** the Beszel hub is at `http://<tailnet-ip>:8090`,
  Gatus at `:8091`. Alerts arrive on the target's ntfy topic.
