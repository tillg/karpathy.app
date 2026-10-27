#!/usr/bin/env bash
# Runs the ingest endpoint's pytest suite (test_server.py) inside the ingest image's test stage. Part of `just check`.
# The image runs by the ID the build prints, untagged: parallel checkouts would otherwise race on one shared tag.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
src=$("${FETCH_SOURCE:-$root/deploy/ingest/fetch-source.sh}")
image=$(docker build -q --build-context "ingest_email=$src" --target test -f "$root/deploy/ingest/Dockerfile" "$root")
docker run --rm "$image" pytest -q -p no:cacheprovider /opt/ingest/test_server.py
