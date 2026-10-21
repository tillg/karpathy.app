#!/usr/bin/env bash
# Tests for deploy/code.sh (`just code [worktree]`): a stub `code` on the PATH records its arguments, a stub
# `hostname` plays the Mac or the dev host.
# Run: bash deploy/code.test.sh (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/nocode"
cat >"$tmp/bin/code" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >"$tmp/args"
EOF
for d in bin nocode; do
  cat >"$tmp/$d/hostname" <<EOF
#!/usr/bin/env bash
echo "\${STUB_HOSTNAME:-the-mac}"
EOF
done
chmod +x "$tmp"/bin/* "$tmp"/nocode/*
# Only the stubs and what code.sh needs from the system (bash, coreutils), not the real `code`.
sys=$(dirname "$(command -v bash)"):/usr/bin:/bin
sys=$(tr ':' '\n' <<<"$sys" | while read -r d; do [ -x "$d/code" ] || echo "$d"; done | paste -sd:)

# run [env…] -- [args…]: code.sh with the stub `code`; prints its output, sets $status.
run() {
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  rm -f "$tmp/args"
  out=$(env -u KARPATHY_DEVHOST -u KARPATHY_DEVHOST_CHECKOUT USER=me PATH="$tmp/bin:$sys" ${envs[@]+"${envs[@]}"} \
    bash "$here/code.sh" "$@" 2>&1)
  status=$?
}
args() { cat "$tmp/args" 2>/dev/null; }

run -- ; eq "no argument opens the main clone" "$(args)" "--remote ssh-remote+karpathy-dev /home/me/karpathy.app"
eq "… exit 0" "$status" 0
run -- x; eq "a worktree opens .worktrees/NAME" "$(args)" "--remote ssh-remote+karpathy-dev /home/me/karpathy.app/.worktrees/x"
run KARPATHY_DEVHOST=box KARPATHY_DEVHOST_CHECKOUT=/srv/k -- y
eq "KARPATHY_DEVHOST and KARPATHY_DEVHOST_CHECKOUT override the defaults" "$(args)" "--remote ssh-remote+box /srv/k/.worktrees/y"

for w in a/b .. .; do
  run -- "$w"
  [ "$status" -ne 0 ] && [ -z "$(args)" ] && ok "'$w' is refused, code not called" || bad "'$w' is refused, code not called" "status $status, args '$(args)'"
done

run STUB_HOSTNAME=karpathy-dev -- x
[ "$status" -eq 1 ] && [ -z "$(args)" ] && ok "on the dev host: exit 1, code not called" || bad "on the dev host: exit 1, code not called" "status $status, args '$(args)'"
[[ "$out" == *"run on the Mac"* && "$out" == *"code .worktrees/x"* ]] && ok "… with the hint" || bad "… with the hint" "$out"

rm -f "$tmp/args"
out=$(env -u KARPATHY_DEVHOST PATH="$tmp/nocode:$sys" bash "$here/code.sh" 2>&1); status=$?
eq "without code on the PATH: exit 1" "$status" 1
[[ "$out" == *"Install 'code' command in PATH"* ]] && ok "… and the hint" || bad "… and the hint" "$out"

[ "$fails" -eq 0 ] && echo "code.test.sh: ok" || { echo "code.test.sh: $fails failed"; exit 1; }
