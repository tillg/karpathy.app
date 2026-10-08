#!/usr/bin/env bash
# `render-settings.sh <target> <outdir>`: renders deploy/settings/ for a target on the controller (role app).
# The target's secrets come as a JSON object (secret name → value) on stdin, never as arguments; they live in
# a private temp store only while the renderer runs. Writes .env, opencode.env and settings.json to
# <outdir>.
set -euo pipefail
target=$1 out=$2
repo=$(cd "$(dirname "$0")/../.." && pwd -P)
store=$(mktemp -d)
trap 'rm -rf "$store"' EXIT
chmod 700 "$store"
# One file per secret, no trailing newline; empty values are left out (optional secrets).
node -e '
  const fs = require("fs"), path = require("path");
  const secrets = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const [name, value] of Object.entries(secrets)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`bad secret name ${name}`);
    if (value) fs.writeFileSync(path.join(process.argv[1], name), String(value), { mode: 0o600 });
  }' "$store"
# The opencode password is generated on the host (role app), not in the vault; settings.json only names its file.
[ -e "$store/opencode_password" ] || printf 'generated-on-the-host' > "$store/opencode_password"
"$repo/node_modules/.bin/tsx" "$repo/packages/settings/src/cli.ts" render "$target" --no-local --out "$out" --secrets "$store"
