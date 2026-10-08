#!/usr/bin/env bash
# `just ingest-auth <target> <email>`: gives the target's ingest service Gmail access (gog, file keyring). Takes this
# Mac's gog OAuth client and the account's refresh token (Keychain, `gog auth add <email>` once) and pipes both into the
# ingest container: nothing is printed or written to disk on the way. Target `dev` = this checkout's dev stack.
set -euo pipefail
cd "$(dirname "$0")"
target=${1:?usage: just ingest-auth <target> <email>} email=${2:?usage: just ingest-auth <target> <email>}
client=${INGEST_CLIENT_JSON:-"$HOME/Library/Application Support/gogcli/credentials.json"}
[ -s "$client" ] || { echo "no gog OAuth client on this Mac ($client): gog auth credentials set <client_secret.json>" >&2; exit 1; }

# Runs a shell command in the target's ingest container, stdin passed through. The keyring password comes
# from the container's secret, as run.sh does it.
in_ingest() {
  local cmd="export GOG_KEYRING_PASSWORD=\$(cat /run/secrets/gog_keyring_password); $1"
  # shellcheck disable=SC2029 # $cmd is quoted here on purpose and runs remotely
  case "$target" in
    dev)
      local n; n=$(cat ../../tmp/dev/stack 2>/dev/null) || { echo "no dev stack for this checkout: just dev up" >&2; exit 1; }
      docker exec -i "karpathy-app-$n-ingest-1" sh -c "$cmd" ;;
    local) ssh -F "$HOME/.lima/karpathy-vm/ssh.config" lima-karpathy-vm "sudo docker exec -i karpathy-app-ingest-1 sh -c $(printf %q "$cmd")" ;;
    hetzner) ssh ops@karpathy "sudo docker exec -i karpathy-app-ingest-1 sh -c $(printf %q "$cmd")" ;;
    *) echo "unknown target: $target (dev, local, hetzner)" >&2; exit 1 ;;
  esac
}

# The refresh token: gog stores the account's token as JSON in the Keychain. INGEST_REFRESH_TOKEN overrides it.
token=${INGEST_REFRESH_TOKEN:-$(security find-generic-password -s gogcli -a "token:default:$email" -w 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])')} \
  || { echo "no gog token for $email in the Keychain: gog auth add $email" >&2; exit 1; }

in_ingest 'gog auth credentials set /dev/stdin >/dev/null' < "$client"
printf %s "$token" | in_ingest "gog auth import --email $(printf %q "$email") --services gmail --refresh-token-stdin >/dev/null"
if ! in_ingest 'gog auth list --plain' | grep -q "^$email"; then
  echo "$target: import ran, but gog auth list doesn't show $email" >&2; exit 1
fi
echo "$target: Gmail connected as $email"
