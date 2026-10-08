#!/usr/bin/env bash
# Tests for deploy/stack.sh (numbered dev stacks). Run: bash deploy/stack.test.sh (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

# Each case runs in a subshell, so exports and cwd changes don't leak.
(
  fails=0
  source "$here/stack.sh"
  stack_ports 3
  eq "stack 3 → proxy 8030" "$PROXY_PORT" 8030
  eq "stack 3 → backend 8031" "$BACKEND_PORT" 8031
  eq "stack 3 exports no OLLAMA_PORT (Ollama is native, outside the stacks)" "${OLLAMA_PORT:-}" ""
  eq "stack 3 → prodtest 8035" "$PRODTEST_PORT" 8035
  eq "stack 3 → project karpathy-app-3" "$STACK_PROJECT" karpathy-app-3
  eq "stack 3 → STACK=3" "$STACK" 3
  exit "$fails"
) || fails=$((fails + 1))
for n in 0 10 x ''; do
  (source "$here/stack.sh"; stack_ports "$n") 2>/dev/null && bad "stack '$n' is rejected" "accepted" || ok "stack '$n' is rejected"
done

# `docker compose ls -a --format json` as Docker prints it (ConfigFiles: comma-separated, override files too).
ls_json='[{"Name":"karpathy-app-2","Status":"running(6)","ConfigFiles":"/x/.worktrees/a/deploy/compose.yml,/x/.worktrees/a/deploy/compose.dev.yml,/x/.worktrees/a/tmp/extra.yml"},{"Name":"karpathy-app-20","Status":"exited(1)","ConfigFiles":"/y/deploy/compose.yml"},{"Name":"steg","Status":"running(1)","ConfigFiles":"/z/docker-compose.yml"}]'
(
  fails=0
  source "$here/stack.sh"
  eq "owner of karpathy-app-2 is /x/.worktrees/a" "$(stack_owner_in "$ls_json" 2)" /x/.worktrees/a
  eq "no project → empty" "$(stack_owner_in "$ls_json" 4)" ""
  eq "karpathy-app-20 does not match stack 2" "$(stack_owner_in '[{"Name":"karpathy-app-20","Status":"exited(1)","ConfigFiles":"/y/deploy/compose.yml"}]' 2)" ""
  eq "empty ls output → empty" "$(stack_owner_in '[]' 2)" ""
  exit "$fails"
) || fails=$((fails + 1))

# Resolution order, each case in its own throwaway checkout (a git repo, as stack_root expects).
checkout() { local d; d=$(mktemp -d); git -C "$d" init -q; echo "$d"; }
(
  fails=0
  source "$here/stack.sh"
  c=$(checkout); cd "$c" || exit 1
  unset STACK
  err=$(stack_resolve "" 2>&1 >/dev/null); rc=$?
  eq "no remembered stack without --new → exit 1" "$rc" 1
  [[ "$err" == *"run just dev up"* ]] && ok "… and says 'run just dev up'" || bad "… and says 'run just dev up'" "$err"
  stack_remember 4
  eq "remembered stack is used" "$(stack_resolve "")" 4
  eq "STACK beats remembered" "$(STACK=5 stack_resolve "")" 5
  eq "arg beats STACK" "$(STACK=5 stack_resolve 6)" 6
  eq "remembered beats --new" "$(stack_resolve "" --new)" 4
  rm -rf "$c"
  exit "$fails"
) || fails=$((fails + 1))
(
  fails=0
  source "$here/stack.sh"
  c=$(checkout); cd "$c" || exit 1
  unset STACK
  n=$(stack_resolve "" --new) || { bad "--new finds a free stack" "none free"; exit 1; }
  eq "a free stack is free" "$(stack_state "$n")" free
  port=80${n}0
  nc -lk 127.0.0.1 "$port" >/dev/null 2>&1 & pid=$!
  for _ in $(seq 50); do nc -z 127.0.0.1 "$port" 2>/dev/null && break; sleep 0.1; done
  eq "a bound 80N0 makes stack $n port-busy" "$(stack_state "$n")" port-busy
  m=$(stack_resolve "" --new)
  [ "$m" != "$n" ] && ok "--new skips port-busy stack $n (took $m)" || bad "--new skips port-busy stack $n" "took $m"
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  # The backend's debug port counts too: something outside Docker held 8021 and stack 2's forward never came up.
  nc -lk 127.0.0.1 "80${n}1" >/dev/null 2>&1 & pid=$!
  for _ in $(seq 50); do nc -z 127.0.0.1 "80${n}1" 2>/dev/null && break; sleep 0.1; done
  eq "a bound 80N1 makes stack $n port-busy" "$(stack_state "$n")" port-busy
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  # And the paired prodtest's port.
  nc -lk 127.0.0.1 "80${n}5" >/dev/null 2>&1 & pid=$!
  for _ in $(seq 50); do nc -z 127.0.0.1 "80${n}5" 2>/dev/null && break; sleep 0.1; done
  eq "a bound 80N5 makes stack $n port-busy" "$(stack_state "$n")" port-busy
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -rf "$c"
  exit "$fails"
) || fails=$((fails + 1))
(
  fails=0
  # A stack another worktree of the same repo remembers is claimed, before its containers exist (the build
  # runs first), so two `just dev up` started minutes apart can't both take it.
  source "$here/stack.sh"
  c=$(checkout); cd "$c" || exit 1
  unset STACK
  git commit -q --allow-empty -m init && git worktree add -q --detach "$c/.worktrees/w" 2>/dev/null
  w=$(cd "$c/.worktrees/w" && pwd -P)
  n=$(stack_first_free)
  mkdir -p "$w/tmp/dev" && echo "$n" > "$w/tmp/dev/stack"
  eq "stack $n remembered by another worktree is claimed" "$(stack_state "$n")" "other:$w"
  [ "$(stack_first_free)" != "$n" ] && ok "first free skips the claimed stack" || bad "first free skips the claimed stack" "took $n"
  eq "… but it is mine in that worktree" "$(cd "$w" && stack_state "$n")" mine
  rm -rf "$c"
  exit "$fails"
) || fails=$((fails + 1))
(
  fails=0
  source "$here/stack.sh"
  stack_ollama_ready http://127.0.0.1:1 && bad "stack_ollama_ready is false for a dead URL" "true" || ok "stack_ollama_ready is false for a dead URL"
  # Needs the machine's native Ollama: skipped, not failed, where none runs.
  if nc -z 127.0.0.1 11434 2>/dev/null; then
    stack_ollama_ready http://127.0.0.1:11434 && ok "stack_ollama_ready is true for 127.0.0.1:11434" \
      || bad "stack_ollama_ready is true for 127.0.0.1:11434" "false"
  else echo "skip stack_ollama_ready against 127.0.0.1:11434 (no native Ollama: just ollama install)"
  fi
  exit "$fails"
) || fails=$((fails + 1))
(
  fails=0
  source "$here/stack.sh"
  d=$(mktemp -d); cd "$d" || exit 1
  err=$(stack_root 2>&1); rc=$?
  [ "$rc" -ne 0 ] && [[ "$err" == *"not in a git checkout"* ]] && ok "stack_root outside a git checkout fails with a hint" \
    || bad "stack_root outside a git checkout fails with a hint" "rc=$rc: $err"
  rm -rf "$d"
  exit "$fails"
) || fails=$((fails + 1))

# deploy/dev.sh against the real Docker daemon.
out=$("$here/dev.sh" stacks 2>&1)
eq "dev.sh stacks prints 9 lines" "$(grep -c 'https://localhost:80[1-9]0' <<<"$out")" 9
# A real project karpathy-app-N on a free stack N, started from another checkout (one sleeping container, no
# ports). The dev.sh cases run only once that project is confirmed, so a failed fixture never lets them start or
# stop a real stack.
n=$(cd "$here" && source ./stack.sh && STACK= stack_first_free)
other=$(cd "$(checkout)" && pwd -P); mkdir -p "$other/deploy"
printf 'services:\n  s:\n    image: alpine\n    command: sleep 600\n' > "$other/deploy/compose.yml"
docker compose -p "karpathy-app-$n" -f "$other/deploy/compose.yml" up -d --quiet-pull >/dev/null 2>&1
if [ "$(source "$here/stack.sh"; stack_owner_in "$(docker compose ls -a --format json)" "$n")" = "$other" ]; then
  claim=$(cat "$here/../tmp/dev/stack" 2>/dev/null || true)
  out=$(STACK= "$here/dev.sh" up "$n" 2>&1); rc=$?
  [ "$rc" -ne 0 ] && [[ "$out" == *"$other"* ]] && ok "dev.sh up N refuses a stack owned by another checkout" \
    || bad "dev.sh up N refuses a stack owned by another checkout" "rc=$rc: $out"
  out=$(STACK= "$here/dev.sh" down "$n" 2>&1); rc=$?
  [ "$rc" -ne 0 ] && [[ "$out" == *"$other"* ]] && ok "dev.sh down N refuses a stack owned by another checkout" \
    || bad "dev.sh down N refuses a stack owned by another checkout" "rc=$rc: $out"
  eq "… and leaves this checkout's claim alone" "$(cat "$here/../tmp/dev/stack" 2>/dev/null || true)" "$claim"
  eq "the fixture project still runs" "$(docker compose -p "karpathy-app-$n" ps -q | wc -l | tr -d ' ')" 1
  rm -rf "$other"
  eq "a stack whose checkout was deleted is orphan" "$(source "$here/stack.sh"; stack_state "$n")" orphan
else
  bad "fixture project karpathy-app-$n from another checkout" "not started"
fi
docker compose -p "karpathy-app-$n" down -t 0 >/dev/null 2>&1
rm -rf "$other"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
