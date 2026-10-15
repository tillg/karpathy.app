#!/usr/bin/env bash
# Runs once when a codespace is created (devcontainer.json postCreateCommand): the tools `just check`, `just dev up`
# and `just e2e` need beyond the image and its features, then seed.sh. Docker comes from the docker-in-docker feature,
# the claude CLI from the claude-code feature.
set -euo pipefail
cd "$(dirname "$0")/.."

sudo apt-get update -qq
sudo apt-get install -y -qq ripgrep jq
command -v just >/dev/null || curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | sudo bash -s -- --to /usr/local/bin

npm install --no-audit --no-fund
npx playwright install --with-deps chromium

bash .devcontainer/seed.sh "$PWD"
echo "codespace ready: just dev up, then forward 8010 (VS Code does; or gh codespace ports forward 8010:8010)"
