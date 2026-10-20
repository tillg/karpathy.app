#!/usr/bin/env bash
# Tests for .devcontainer/seed.sh (a codespace's secrets). Run: bash .devcontainer/seed.test.sh
# (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

# A temp repo with just what seed.sh touches; the committed settings so dev can be rendered.
fresh() {
  local d; d=$(mktemp -d)
  mkdir -p "$d/deploy/settings"
  cp "$repo"/deploy/settings/*.yaml "$d/deploy/settings/"
  rm -f "$d"/deploy/settings/*.local.yaml
  echo "$d"
}
seed() { env -u OPENROUTER_API_KEY -u EXA_API_KEY -u NTFY_DEV_TOPIC "$@" bash "$here/seed.sh" "$d"; }

d=$(fresh)
seed OPENROUTER_API_KEY=or-key EXA_API_KEY=exa-key NTFY_DEV_TOPIC=karpathy-development-x >/dev/null 2>&1
eq "fresh: seed exits 0" "$?" 0
[ -e "$d/deploy/settings/dev.local.yaml" ] && bad "fresh: no dev.local.yaml (dev is on OpenRouter)" "written" \
  || ok "fresh: no dev.local.yaml (dev is on OpenRouter)"
eq "fresh: openrouter key from OPENROUTER_API_KEY" "$(cat "$d/deploy/secrets/openrouter_api_key" 2>/dev/null)" or-key
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; } # GNU (codespace) or BSD (Mac)
eq "fresh: the key file is mode 600" "$(mode "$d/deploy/secrets/openrouter_api_key")" 600
eq "fresh: exa key from EXA_API_KEY" "$(cat "$d/deploy/secrets/exa_api_key" 2>/dev/null)" exa-key
eq "fresh: ntfy topic from NTFY_DEV_TOPIC" "$(cat "$d/tmp/.ntfy_dev_topic" 2>/dev/null)" karpathy-development-x

# Dev renders with the seeded key and the dev secrets dev.sh creates, on OpenRouter.
for f in bearer_token opencode_password gog_keyring_password ingest_token; do echo x > "$d/deploy/secrets/$f"; done
touch "$d/deploy/secrets/github_token" "$d/deploy/secrets/dns_api_token"
if "$repo/node_modules/.bin/tsx" "$repo/packages/settings/src/cli.ts" render dev --dir "$d/deploy/settings" \
    --out "$d/out" --secrets "$d/deploy/secrets" --compose-dir "$repo/deploy" >/dev/null 2>&1; then
  ok "fresh: dev renders"
  grep -q '"model": *"openrouter/' "$d/out/settings.json" && ok "fresh: dev's model is on OpenRouter" \
    || bad "fresh: dev's model is on OpenRouter" "$(grep '"model"' "$d/out/settings.json")"
else
  bad "fresh: dev renders" "settings render failed"
fi

# Existing files are the developer's: never overwritten.
seed OPENROUTER_API_KEY=other NTFY_DEV_TOPIC=other >/dev/null 2>&1
eq "existing: key left alone" "$(cat "$d/deploy/secrets/openrouter_api_key")" or-key
eq "existing: ntfy topic left alone" "$(cat "$d/tmp/.ntfy_dev_topic")" karpathy-development-x
rm -rf "$d"

# No OPENROUTER_API_KEY: no key file, a hint, exit 0 (dev up then names the missing secret).
d=$(fresh)
err=$(seed 2>&1 >/dev/null); code=$?
eq "no key: seed exits 0" "$code" 0
[ -e "$d/deploy/secrets/openrouter_api_key" ] && bad "no key: no key file" "written" || ok "no key: no key file"
[ -e "$d/deploy/secrets/exa_api_key" ] && bad "no key: no exa file" "written" || ok "no key: no exa file"
case "$err" in *OPENROUTER_API_KEY*) ok "no key: hint names OPENROUTER_API_KEY" ;; *) bad "no key: hint names OPENROUTER_API_KEY" "stderr: $err" ;; esac
rm -rf "$d"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
