# karpathy.app development commands. `just` lists them.

# List all recipes
default:
    @just --list

# Install the npm workspace dependencies (after clone or in a fresh worktree)
install:
    npm install

# Dev stack N on https://localhost:80N0: `just dev up [N]` (default: this checkout's stack, else the first free); `just dev down|logs|ps|token|stacks`
dev action="up" *args:
    deploy/dev.sh {{action}} {{args}}

# Resume this checkout's last Claude Code session (e.g. after reconnecting to a remote dev host); extra args go to claude
resume *args:
    claude --continue {{args}}

# Build the website into _site/ and preview it on http://localhost:<port> (default 8099)
site port="8099":
    site/build.sh
    python3 -m http.server {{port}} --bind 127.0.0.1 -d _site

# Secret scan (gitleaks), lint, typecheck and unit + integration tests
check:
    bash deploy/check-preflight.sh
    bash deploy/gitleaks/scan-repo.sh
    npm run lint
    npm run typecheck
    npm test
    just settings check
    bash deploy/stack.test.sh
    bash deploy/ansible/dev.test.sh
    bash deploy/check-preflight.test.sh
    bash deploy/code.test.sh
    bash deploy/tailnet-serve.test.sh
    bash deploy/ansible/tailscale-tag.test.sh
    bash deploy/justfile.test.sh
    bash deploy/ingest/run.test.sh
    bash deploy/ingest/compose.test.sh
    bash deploy/ingest/server.test.sh
    node --experimental-strip-types --test e2e/stack.unit.ts

# App settings (deploy/settings/): `just settings show <env>|check|render <env> --out <dir> --secrets <dir>`
settings *args:
    @node_modules/.bin/tsx packages/settings/src/cli.ts {{args}}

# Move pictures next to the notes that show them (own note folder): `just tidy-attachments <vault dir> [--apply]` (dry run without --apply)
tidy-attachments dir *flags:
    @node_modules/.bin/tsx apps/backend/src/tidy-attachments-cli.ts {{dir}} {{flags}}

# Unit + integration tests (needs Docker); extra args go to the test runner
test *args:
    npm test -- {{args}}

# Playwright e2e against this checkout's dev stack; extra args go to Playwright
[positional-arguments]
e2e *args:
    npx playwright test "$@"

# Prod images on https://localhost:80N5, paired with this checkout's dev stack N: `just prodtest` starts it; `just prodtest down`; `just prodtest e2e [playwright args]`
prodtest action="up" *args:
    #!/usr/bin/env bash
    set -euo pipefail
    source deploy/stack.sh
    # A running prodtest remembers its stack (tmp/prodtest/stack), so e2e and down find it after `just dev down`.
    n=$(cat tmp/prodtest/stack 2>/dev/null || stack_resolve "")
    stack_ports "$n"
    prodtest_compose() { docker compose -p "$STACK_PROJECT-prodtest" -f deploy/compose.yml -f deploy/compose.prodtest.yml $([ -f tmp/settings/prodtest/.env ] && echo --env-file tmp/settings/prodtest/.env) "$@"; }
    case "{{action}}" in
      up)
        mkdir -p tmp/prodtest/secrets
        [ -s tmp/prodtest/secrets/bearer_token ] || openssl rand -hex 24 > tmp/prodtest/secrets/bearer_token
        [ -s tmp/prodtest/secrets/opencode_password ] || openssl rand -hex 24 > tmp/prodtest/secrets/opencode_password
        [ -s tmp/prodtest/secrets/gog_keyring_password ] || openssl rand -hex 24 > tmp/prodtest/secrets/gog_keyring_password
        [ -s tmp/prodtest/secrets/ingest_token ] || openssl rand -hex 24 > tmp/prodtest/secrets/ingest_token
        touch tmp/prodtest/secrets/github_token tmp/prodtest/secrets/dns_api_token
        # Provider keys of a hosted gateway (deploy/settings/prodtest.local.yaml) come from the dev secrets.
        for k in deploy/secrets/*_api_key; do [ -e "$k" ] && cp "$k" tmp/prodtest/secrets/; done
        settings_legacy_check
        settings_render prodtest tmp/prodtest/secrets
        echo "$n" > tmp/prodtest/stack
        # The ingest image's build context for the private ingest-email repo.
        deploy/ingest/fetch-source.sh >/dev/null
        prodtest_compose up -d --build
        echo "App: https://localhost:$PRODTEST_PORT  token: $(cat tmp/prodtest/secrets/bearer_token)"
        ;;
      down) prodtest_compose down -v && rm -f tmp/prodtest/stack ;;
      e2e) E2E_BASE_URL=https://localhost:$PRODTEST_PORT E2E_TOKEN_FILE=tmp/prodtest/secrets/bearer_token E2E_BACKEND_CONTAINER=$STACK_PROJECT-prodtest-backend-1 npx playwright test {{args}} ;;
      *) echo "usage: just prodtest [up|down|e2e]" >&2; exit 1 ;;
    esac

# Cut a release: tags v<version> (X.Y.Z or X.Y.Z-rc.N) on HEAD, pushes the tag, prints the workflow run
release version:
    #!/usr/bin/env bash
    set -euo pipefail
    v="{{version}}"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || { echo "version must be X.Y.Z or X.Y.Z-rc.N (no v)" >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty: commit first" >&2; exit 1; }
    git fetch -q origin main
    # Final releases only from main; release candidates may come from any commit.
    if [[ "$v" != *-rc.* ]]; then
      git merge-base --is-ancestor HEAD origin/main || { echo "HEAD is not on origin/main: a final release must be" >&2; exit 1; }
    fi
    git tag -a "v$v" -m "v$v"
    git push origin "v$v"
    sleep 5
    gh run list --workflow release.yml --limit 1 --json url --jq '.[0].url'

# Deploy a release to a target (hetzner): `just deploy hetzner [X.Y.Z] [--only app|monitoring]`
deploy target *args:
    deploy/ansible/deploy.sh run {{target}} {{args}}

# Dry run of `just deploy` (check mode with diff): changes nothing
deploy-check target *args:
    deploy/ansible/deploy.sh check {{target}} {{args}}

# Set up the remote dev host karpathy-dev (deploy/README.md, "Dev server"): `just devhost [--check] [--bootstrap <public-ip>]`
devhost *args:
    deploy/devhost.sh {{args}}

# On the Mac: a VS Code window on the remote dev host (docs/dev-server.md, "VS Code"): `just code [worktree]`
code worktree="":
    bash deploy/code.sh {{worktree}}

# The browser editor (code-server) on the dev host, on a checkout (docs/dev-server.md, "iPad"): `just code-web [worktree]`; on the dev host it prints a QR code for the iPad
code-web worktree="":
    bash deploy/code.sh --web {{worktree}}

# Copy a target's access token to the clipboard; `--qr` also prints a login QR code for a phone/iPad
token target *flag:
    deploy/ansible/token.sh {{target}} {{flag}}

# Give a target's ingest service Gmail access: this Mac's gog OAuth client + the account's refresh token (`dev` = this checkout's dev stack)
ingest-auth target email:
    deploy/ansible/ingest-auth.sh {{target}} {{email}}

# Copy an ntfy topic to the clipboard (subscribe to it in the ntfy app): a target's alert topic, or `dev` for dev progress (Keychain karpathy-ntfy-dev; tmp/.ntfy_dev_topic without a Keychain). Without a clipboard (a remote dev host) it prints the topic
ntfy-topic target:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{target}}" != dev ]; then topic=$(deploy/ansible/vault-get.sh "{{target}}" vault_ntfy_topic)
    elif command -v security >/dev/null; then topic=$(security find-generic-password -s karpathy-ntfy-dev -w)
    else topic=$(cat tmp/.ntfy_dev_topic 2>/dev/null) || { echo "no Keychain here: put the dev topic into tmp/.ntfy_dev_topic" >&2; exit 1; }
    fi
    topic=$(printf %s "$topic" | tr -d '\n')
    if command -v pbcopy >/dev/null; then printf %s "$topic" | pbcopy && echo "ntfy topic for {{target}} copied to the clipboard."
    else echo "ntfy topic for {{target}}: $topic"; fi

# Watch Hetzner for a cheaper server (CX23/CAX11), twice a day with an ntfy push: `just hetzner-watch install|uninstall|now`
hetzner-watch action:
    #!/usr/bin/env bash
    set -euo pipefail
    label=app.karpathy.hetzner-watch
    plist=~/Library/LaunchAgents/$label.plist
    script="$PWD/deploy/hetzner-watch/check.sh"
    case "{{action}}" in
      install)
        mkdir -p ~/Library/LaunchAgents ~/Library/Logs
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
          '<plist version="1.0"><dict>' \
          "<key>Label</key><string>$label</string>" \
          "<key>ProgramArguments</key><array><string>$script</string></array>" \
          '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>' \
          '<key>StartCalendarInterval</key><array>' \
          '<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>' \
          '<dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>' \
          '</array>' \
          "<key>StandardOutPath</key><string>$HOME/Library/Logs/hetzner-watch.log</string>" \
          "<key>StandardErrorPath</key><string>$HOME/Library/Logs/hetzner-watch.log</string>" \
          '</dict></plist>' > "$plist"
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$plist"
        echo "installed: 08:00 and 14:00, log ~/Library/Logs/hetzner-watch.log" ;;
      uninstall) launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true; rm -f "$plist"; echo uninstalled ;;
      now) "$script" ;;
      *) echo "usage: just hetzner-watch install|uninstall|now" >&2; exit 1 ;;
    esac

# Fill a target's vault interactively (hidden input; generates token, Beszel secrets, ntfy topic)
secrets target:
    PYTHONDONTWRITEBYTECODE=1 "$(head -1 "$(which ansible)" | sed 's/^#!//')" deploy/ansible/fill_vault.py {{target}}
