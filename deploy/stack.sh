# Numbered dev stacks: stack N (1-9) is compose project karpathy-app-N on the port block 80N0-80N9.
# Sourced by deploy/dev.sh and the justfile; tests in deploy/stack.test.sh.

command -v jq >/dev/null || { echo "deploy/stack.sh needs jq: brew install jq" >&2; return 1; }

# Exports the stack's number, compose project and ports; fails for N outside 1-9.
stack_ports() {
  [[ "${1:-}" =~ ^[1-9]$ ]] || { echo "stack must be 1-9, got '${1:-}'" >&2; return 1; }
  export STACK=$1 STACK_PROJECT=karpathy-app-$1
  export PROXY_PORT=80${1}0 BACKEND_PORT=80${1}1 PRODTEST_PORT=80${1}5
}

# Prints the checkout that started project karpathy-app-N, from `docker compose ls -a --format json` output
# (the directory above its deploy/compose.yml); nothing if there is no such project.
stack_owner_in() {
  jq -r --arg name "karpathy-app-$2" '.[] | select(.Name == $name) | .ConfigFiles | split(",")[]
    | select(endswith("/deploy/compose.yml")) | rtrimstr("/deploy/compose.yml")' <<<"$1" | head -1
}

# This checkout (main clone or worktree), with symlinks resolved.
stack_root() {
  local top
  top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not in a git checkout of karpathy.app" >&2; return 1; }
  (cd "$top" && pwd -P)
}

# The checkout of this repo (main clone or worktree) whose tmp/dev/stack remembers stack N: its claim from
# `just dev up` on, before compose has created any container, until `just dev down`.
stack_claimant() {
  local w
  git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r w; do
    [ "$(cat "$w/tmp/dev/stack" 2>/dev/null)" = "$1" ] && (cd "$w" && pwd -P)
  done | head -1
}

# mine | free | other:<checkout> | orphan | port-busy. A stopped project still belongs to its checkout; one whose
# checkout was deleted is orphan (any checkout may take it over).
stack_state() {
  local ls owner root
  ls=$(docker compose ls -a --format json) || { echo "Docker is not reachable" >&2; return 1; }
  root=$(stack_root) || return 1
  owner=$(stack_owner_in "$ls" "$1")
  if [ -n "$owner" ] && [ ! -d "$owner" ]; then echo orphan; return; fi
  [ -n "$owner" ] || owner=$(stack_claimant "$1")
  if [ -n "$owner" ]; then
    owner=$(cd "$owner" && pwd -P)
    [ "$owner" = "$root" ] && echo mine || echo "other:$owner"
  # Any port the stack publishes (proxy, backend, paired prodtest) held by something else.
  elif nc -z 127.0.0.1 "80${1}0" 2>/dev/null || nc -z 127.0.0.1 "80${1}1" 2>/dev/null || nc -z 127.0.0.1 "80${1}5" 2>/dev/null; then
    echo port-busy
  else echo free
  fi
}

# Prints the stack number: ARG, else $STACK, else the one this checkout remembers (tmp/dev/stack),
# else with --new the first free stack.
stack_resolve() {
  local f
  f="$(stack_root)/tmp/dev/stack"
  if [ -n "${1:-}" ]; then echo "$1"; return; fi
  if [ -n "${STACK:-}" ]; then echo "$STACK"; return; fi
  if [ -s "$f" ]; then cat "$f"; return; fi
  [ "${2:-}" = --new ] && { stack_first_free; return; }
  echo "no dev stack for this checkout: run just dev up" >&2; return 1
}

stack_first_free() {
  local n
  for n in 1 2 3 4 5 6 7 8 9; do [ "$(stack_state "$n")" = free ] && { echo "$n"; return; }; done
  echo "no free dev stack (1-9): see just dev stacks" >&2; return 1
}

# True if the native Ollama (`just ollama install`) answers at URL.
stack_ollama_ready() { curl -sf -m 3 "$1/api/version" >/dev/null; }

stack_remember() { mkdir -p "$(stack_root)/tmp/dev" && echo "$1" > "$(stack_root)/tmp/dev/stack"; }
