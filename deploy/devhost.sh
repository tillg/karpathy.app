#!/usr/bin/env bash
# `just devhost [--check] [--bootstrap <public-ip>]`: brings the remote dev host (inventories/dev) to the state of
# dev.yml (deploy/README.md, "Dev server"). --check is a dry run with diff; the first run against a freshly booked
# server goes as root on its public IP (--bootstrap), later runs over Tailscale.
set -euo pipefail
mode=run args=()
for a in "$@"; do
  case "$a" in --check) mode=check ;; *) args+=("$a") ;; esac
done
PLAYBOOK=dev.yml exec "$(dirname "$0")/ansible/deploy.sh" "$mode" dev ${args[@]+"${args[@]}"}
