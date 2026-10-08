#!/usr/bin/env bash
# Checks out ingest-email (private repo tillg/ingest_email) at the commit in ingest-email.ref into
# tmp/ingest_email-src: the ingest image's named build context `ingest_email`. Uses this machine's git access to
# GitHub; CI checks it out with a read-only deploy key instead. Prints the directory.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
ref=$(cat "$root/deploy/ingest/ingest-email.ref")
dir="$root/tmp/ingest_email-src"
[ -d "$dir/.git" ] || git clone -q --no-checkout https://github.com/tillg/ingest_email.git "$dir"
git -C "$dir" cat-file -e "$ref^{commit}" 2>/dev/null || git -C "$dir" fetch -q origin
git -C "$dir" checkout -q --detach "$ref"
echo "$dir"
