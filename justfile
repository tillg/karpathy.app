# karpathy.app development commands. `just` lists them.

prodtest_compose := "docker compose -p karpathy-app-prodtest -f deploy/compose.yml -f deploy/compose.prodtest.yml"

# List all recipes
default:
    @just --list

# Install the npm workspace dependencies (after clone or in a fresh worktree)
install:
    npm install

# Dev stack on https://localhost:8443: `just dev` starts it; `just dev down|logs|ps|token`
dev action="up":
    deploy/dev.sh {{action}}

# Build the website into _site/ and preview it on http://localhost:<port> (default 8099)
site port="8099":
    site/build.sh
    python3 -m http.server {{port}} --bind 127.0.0.1 -d _site

# Lint, typecheck and unit + integration tests
check:
    npm run lint
    npm run typecheck
    npm test

# Unit + integration tests (needs Docker); extra args go to the test runner
test *args:
    npm test -- {{args}}

# Playwright e2e against the running dev stack; extra args go to Playwright
e2e *args:
    npx playwright test {{args}}

# Prod images on https://localhost:9443, next to the dev stack: `just prodtest` starts it; `just prodtest down`; `just prodtest e2e [playwright args]`
prodtest action="up" *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{action}}" in
      up)
        mkdir -p tmp/prodtest/secrets
        [ -s tmp/prodtest/secrets/bearer_token ] || openssl rand -hex 24 > tmp/prodtest/secrets/bearer_token
        [ -s tmp/prodtest/secrets/opencode_password ] || openssl rand -hex 24 > tmp/prodtest/secrets/opencode_password
        touch tmp/prodtest/secrets/github_token tmp/prodtest/secrets/dns_api_token
        {{prodtest_compose}} up -d --build
        echo "App: https://localhost:9443  token: $(cat tmp/prodtest/secrets/bearer_token)"
        ;;
      down) {{prodtest_compose}} down -v ;;
      e2e) E2E_BASE_URL=https://localhost:9443 E2E_TOKEN_FILE=tmp/prodtest/secrets/bearer_token E2E_BACKEND_CONTAINER=karpathy-app-prodtest-backend-1 npx playwright test {{args}} ;;
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

# Local deploy target VM (Lima): `just vm up` (create once, then start), `down` (stop), `reset` (recreate), `ssh [-- cmd]`
[positional-arguments]
vm action *args:
    #!/usr/bin/env bash
    set -euo pipefail
    shift
    name=karpathy-vm
    up() {
      mkdir -p tmp/dev/remotes
      if limactl list -q | grep -qx "$name"; then limactl start "$name"
      else limactl start --tty=false --name "$name" --set ".mounts[0].location = \"$PWD/tmp/dev/remotes\"" deploy/lima/karpathy-vm.yaml
      fi
    }
    case "{{action}}" in
      up) up ;;
      down) limactl stop "$name" ;;
      reset) limactl delete -f "$name" 2>/dev/null || true; up ;;
      ssh) [ "${1:-}" = "--" ] && shift; limactl shell "$name" "$@" ;;
      *) echo "usage: just vm [up|down|reset|ssh [-- cmd]]" >&2; exit 1 ;;
    esac

# Deploy a release to a target (local|hetzner): `just deploy local [X.Y.Z] [--only app|monitoring]`
deploy target *args:
    deploy/ansible/deploy.sh run {{target}} {{args}}

# Dry run of `just deploy` (check mode with diff): changes nothing
deploy-check target *args:
    deploy/ansible/deploy.sh check {{target}} {{args}}

# Playwright suite (minus @llm) against a deployed target; only `local` (the VM on https://localhost:9444)
deploy-e2e target *args:
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{target}}" = local ] || { echo "deploy-e2e runs against local only" >&2; exit 1; }
    mkdir -p tmp/local && umask 077
    deploy/ansible/vault-get.sh local vault_bearer_token > tmp/local/bearer_token
    url=https://localhost:9444
    # The release the PWA and the server must report: E2E_EXPECT_VERSION, else what the server runs.
    version=${E2E_EXPECT_VERSION:-$(curl -sfk -H "Authorization: Bearer $(cat tmp/local/bearer_token)" $url/api/health | jq -r .version)}
    echo "e2e against $url, release $version"
    E2E_BASE_URL=$url E2E_TOKEN_FILE=tmp/local/bearer_token E2E_EXPECT_VERSION="$version" \
      E2E_DOCKER="limactl shell karpathy-vm sudo docker" E2E_BACKEND_CONTAINER=karpathy-app-backend-1 \
      npx playwright test --grep-invert @llm {{args}}

# Copy a target's access token to the clipboard; `--qr` also prints a login QR code for a phone/iPad
token target *flag:
    deploy/ansible/token.sh {{target}} {{flag}}

# Copy an ntfy topic to the clipboard (subscribe to it in the ntfy app): a target's alert topic, or `dev` for dev progress (Keychain karpathy-ntfy-dev)
ntfy-topic target:
    {{ if target == "dev" { "security find-generic-password -s karpathy-ntfy-dev -w" } else { "deploy/ansible/vault-get.sh " + target + " vault_ntfy_topic" } }} | tr -d '\n' | pbcopy && echo "ntfy topic for {{target}} copied to the clipboard."

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
