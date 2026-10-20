#!/usr/bin/env bash
# Seeds a codespace's checkout from its Codespaces secrets (specs/changes/codespaces-dev): the provider keys (dev runs
# on OpenRouter, like everywhere) and the ntfy dev topic. Never overwrites an existing file: the
# developer's own edits win. No network, no installs. Usage: seed.sh <repo root>
set -euo pipefail
root=${1:?usage: seed.sh <repo root>}

# write FILE MODE CONTENT: only if FILE doesn't exist yet.
write() {
  [ -e "$1" ] && return 0
  mkdir -p "$(dirname "$1")"
  (umask 077; printf '%s\n' "$3" > "$1")
  chmod "$2" "$1"
  echo "seeded ${1#"$root"/}"
}

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  write "$root/deploy/secrets/openrouter_api_key" 600 "$OPENROUTER_API_KEY"
else
  echo "no OPENROUTER_API_KEY: add it as a Codespaces secret (GitHub → Settings → Codespaces), or put the key into deploy/secrets/openrouter_api_key" >&2
fi
[ -z "${EXA_API_KEY:-}" ] || write "$root/deploy/secrets/exa_api_key" 600 "$EXA_API_KEY"
[ -z "${NTFY_DEV_TOPIC:-}" ] || write "$root/tmp/.ntfy_dev_topic" 600 "$NTFY_DEV_TOPIC"

# The optional secrets: name each missing one and what goes without it.
missing() { [ -n "${!1:-}" ] || echo "no $1 (optional): $2" >&2; }
missing EXA_API_KEY "the AI has no web search"
missing NTFY_DEV_TOPIC "no ntfy progress messages"
missing ANTHROPIC_API_KEY "log in to claude once by hand"
exit 0
