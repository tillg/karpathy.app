#!/usr/bin/env bash
# Seeds a codespace's checkout from its Codespaces secrets (specs/changes/codespaces-dev): the hosted-gateway overlay
# (a codespace has no omlx), the provider keys and the ntfy dev topic. Never overwrites an existing file: the
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

write "$root/deploy/settings/dev.local.yaml" 644 "# Written by .devcontainer/seed.sh: a codespace has no omlx, so dev stacks use the hosted gateway.
ai: { gateway: openrouter, model: openrouter/z-ai/glm-5.3, vision_model: openrouter/mistralai/mistral-medium-3-5 }"

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  write "$root/deploy/secrets/openrouter_api_key" 600 "$OPENROUTER_API_KEY"
else
  echo "no OPENROUTER_API_KEY: add it as a Codespaces secret (GitHub → Settings → Codespaces), or put the key into deploy/secrets/openrouter_api_key" >&2
fi
[ -z "${EXA_API_KEY:-}" ] || write "$root/deploy/secrets/exa_api_key" 600 "$EXA_API_KEY"
[ -z "${NTFY_DEV_TOPIC:-}" ] || write "$root/tmp/.ntfy_dev_topic" 600 "$NTFY_DEV_TOPIC"
exit 0
