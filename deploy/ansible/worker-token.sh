#!/usr/bin/env bash
# `just instagram-worker-token <target>`: prints the target's Instagram worker token (#168), for
# `karpathy-instagram-worker configure` (docs/instagram-worker.md). Printed, not copied to the clipboard: the worker
# may run on another machine than this one. The token is a credential: paste it only into the worker's configure.
#   dev       this checkout's dev stack (deploy/secrets/, made by `just dev up`)
#   prodtest  this checkout's prodtest stack (tmp/prodtest/secrets/, made by `just prodtest up`)
#   hetzner   the server's copy, generated there by the deploy (role app › Ingest secrets)
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd -P)
target=${1:?usage: just instagram-worker-token <target> (dev, prodtest, hetzner)}
local_token() { # <file> <how to make it>
  [ -s "$1" ] || { echo "no worker token in $1: $2 first" >&2; exit 1; }
  tr -d '\n' <"$1"; echo
}
case "$target" in
  dev) local_token "$repo/deploy/secrets/ingest_worker_token" "just dev up" ;;
  prodtest) local_token "$repo/tmp/prodtest/secrets/ingest_worker_token" "just prodtest up" ;;
  hetzner) ssh ops@karpathy "sudo cat /opt/karpathy.app/shared/secrets/ingest_worker_token" ;;
  *) echo "unknown target: $target (dev, prodtest, hetzner)" >&2; exit 1 ;;
esac
