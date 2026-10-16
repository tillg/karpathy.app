#!/usr/bin/env bash
# `just check`'s preflight: refuses to start the suite when its container tests would only time out.
# Run: bash deploy/check-preflight.test.sh (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/check-preflight.sh
source "$here/check-preflight.sh"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
refuses() { ! "$@" 2>/dev/null; }

check "a quiet machine with Docker passes" preflight 4.2 16 1
check "Docker not answering is refused" refuses preflight 1.0 16 0
check "load above 3 per core is refused (94 on 16 cores: the 16 timeouts of 2026-10-15)" refuses preflight 94.6 16 1
check "load at 3 per core passes" preflight 48 16 1
msg=$(preflight 94.6 16 1 2>&1)
check "the refusal says how to run anyway" grep -q CHECK_IGNORE_LOAD <<<"$msg"

[ "$fails" -eq 0 ] && echo "check-preflight.test.sh: ok" || { echo "check-preflight.test.sh: $fails failed"; exit 1; }
