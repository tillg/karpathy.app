#!/usr/bin/env bash
# Tests for justfile recipes that pass arguments on: a stub `npx` on the PATH records each argument on its own line,
# so an argument with spaces (`--grep "a b c"`) must arrive as one.
# Run: bash deploy/justfile.test.sh (part of `just check`).
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/npx" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$tmp/args"
EOF
chmod +x "$tmp/bin/npx"

PATH="$tmp/bin:$PATH" just --justfile "$root/justfile" --working-directory "$root" e2e --grep "a b c" >/dev/null 2>&1
eq "e2e keeps a quoted argument whole" "$(cat "$tmp/args" 2>/dev/null)" "$(printf '%s\n' playwright test --grep 'a b c')"

PATH="$tmp/bin:$PATH" just --justfile "$root/justfile" --working-directory "$root" e2e >/dev/null 2>&1
eq "e2e without arguments" "$(cat "$tmp/args" 2>/dev/null)" "$(printf '%s\n' playwright test)"

# instagram-worker-token runs deploy/ansible/worker-token.sh with the target: hetzner → ssh (stubbed).
cat >"$tmp/bin/ssh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$tmp/ssh-args"
echo wt-from-ssh
EOF
chmod +x "$tmp/bin/ssh"
out=$(PATH="$tmp/bin:$PATH" just --justfile "$root/justfile" --working-directory "$root" instagram-worker-token hetzner 2>&1)
eq "instagram-worker-token passes the target on" "$(head -1 "$tmp/ssh-args" 2>/dev/null)" "ops@karpathy"
eq "… and prints the token" "$out" "wt-from-ssh"

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
