#!/usr/bin/env bash
# Runs the ingest endpoint's pytest suite (test_server.py) inside the ingest image's test stage. Part of `just check`.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
src=$("$root/deploy/ingest/fetch-source.sh")
docker build -q --build-context "ingest_email=$src" --target test -t kai-test-ingest-stage -f "$root/deploy/ingest/Dockerfile" "$root" >/dev/null
docker run --rm kai-test-ingest-stage pytest -q -p no:cacheprovider /opt/ingest/test_server.py
