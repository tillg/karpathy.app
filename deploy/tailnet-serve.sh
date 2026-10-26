#!/usr/bin/env bash
# `tailnet-serve.sh <https-port> <target-url>`: makes `tailscale serve` publish <target-url> at
# https://<this node>.<tailnet>.ts.net:<https-port>/ (a tailnet URL, specs/changes/ipad-code-server), idempotently.
# Prints `changed` or `unchanged`; exit 3 while the tailnet's HTTPS certificates are off, 1 when serve fails.
# Other ports' serve entries stay. Run as root (Ansible, role code_server). Needs jq.
set -euo pipefail
port=${1:?usage: tailnet-serve.sh <https-port> <target-url>}
target=${2:-}
[ -n "$target" ] || { echo "usage: tailnet-serve.sh <https-port> <target-url>" >&2; exit 2; }

status=$(tailscale status --json)
if [ "$(jq -r '.CertDomains // [] | length' <<<"$status")" = 0 ]; then
  echo "tailnet-serve: the tailnet's HTTPS certificates are off. Turn on HTTPS Certificates in the Tailscale admin" \
    "console (DNS page), then run again." >&2
  exit 3
fi

node=$(jq -r '.Self.DNSName | rtrimstr(".")' <<<"$status")
current=$(tailscale serve status --json | jq -r --arg web "$node:$port" '.Web[$web].Handlers["/"].Proxy // ""')
if [ "$current" = "$target" ]; then
  echo unchanged
  exit 0
fi

# Where serve isn't allowed, it prints an approval URL and waits for a browser: give up instead.
if ! out=$(timeout 30 tailscale serve --bg --https="$port" "$target" 2>&1); then
  echo "tailnet-serve: tailscale serve --bg --https=$port $target failed:" >&2
  echo "$out" >&2
  exit 1
fi
echo changed
