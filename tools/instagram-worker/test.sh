#!/usr/bin/env bash
# Runs the Instagram worker's pytest suite in python:3.11-slim (the oldest supported Python), with instascraper and
# instagrapi replaced by the stubs in tests/stubs/. Part of `just check`. Extra args go to pytest.
# Run: bash tools/instagram-worker/test.sh [-k pattern]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
image=kai-test-instagram-worker
docker build -q -t "$image" - >/dev/null <<'DOCKERFILE'
FROM python:3.11-slim
RUN pip install --no-cache-dir pytest==8.3.3
DOCKERFILE
# The source is mounted read-only and copied, so a run leaves no root-owned __pycache__ in the checkout.
docker run --rm -v "$here:/src:ro" "$image" sh -c \
  'cp -r /src /tmp/w && cd /tmp/w && exec python -m pytest -q -p no:cacheprovider tests "$@"' sh "$@"
