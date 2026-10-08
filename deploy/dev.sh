#!/usr/bin/env bash
# Dev stack N (1-9): https://localhost:80N0 (Caddy internal CA), hot reload, the Mac's native Ollama as the model.
# Usage: deploy/dev.sh [up [N]|down|logs|ps|token|stacks]  (or `just dev [...]`)
# `up` without N reuses this checkout's stack (tmp/dev/stack, its claim), else takes the first free one;
# `down` releases it.
set -euo pipefail
cd "$(dirname "$0")"
source ./stack.sh
compose() { docker compose -p "$STACK_PROJECT" -f compose.yml -f compose.dev.yml "$@"; }

case "${1:-up}" in
  up)
    n=$(stack_resolve "${2:-}" --new)
    stack_ports "$n"
    state=$(stack_state "$n")
    case "$state" in
      other:*|port-busy)
        echo "stack $n is taken ($state); first free: $(stack_first_free 2>/dev/null || echo none). See just dev stacks" >&2
        exit 1 ;;
    esac
    # One stack per checkout: a different one must go down (and be released) first.
    old=$(cat "$(stack_root)/tmp/dev/stack" 2>/dev/null || true)
    if [ -n "$old" ] && [ "$old" != "$n" ] && [ "$(stack_state "$old")" = mine ]; then
      echo "this checkout holds stack $old: just dev down first" >&2; exit 1
    fi
    stack_ollama_ready http://127.0.0.1:11434 || { echo "no Ollama on 127.0.0.1:11434: just ollama install" >&2; exit 1; }
    stack_remember "$n"
    mkdir -p secrets ../tmp/dev/remotes
    [ -s secrets/bearer_token ] || openssl rand -hex 24 > secrets/bearer_token
    [ -s secrets/opencode_password ] || openssl rand -hex 24 > secrets/opencode_password
    touch secrets/github_token secrets/dns_api_token
    # The dev model (~2 GB) lives with the native Ollama, pulled once for all stacks.
    ollama show qwen2.5:3b >/dev/null 2>&1 || ollama pull qwen2.5:3b
    compose up -d --build
    echo "Stack $n: https://localhost:$PROXY_PORT  token: $(cat secrets/bearer_token)"
    ;;
  down|logs|ps)
    n=$(stack_resolve "${2:-}")
    stack_ports "$n"
    state=$(stack_state "$n")
    case "$state" in other:*|port-busy) echo "stack $n is not this checkout's ($state)" >&2; exit 1 ;; esac
    case "$1" in
      # down also releases the stack: tmp/dev/stack is this checkout's claim on it.
      down)
        compose down
        if [ "$(cat "$(stack_root)/tmp/dev/stack" 2>/dev/null)" = "$n" ]; then rm -f "$(stack_root)/tmp/dev/stack"; fi
        ;;
      logs) compose logs -f ;;
      ps) compose ps ;;
    esac
    ;;
  token) cat secrets/bearer_token ;;
  stacks)
    for n in 1 2 3 4 5 6 7 8 9; do
      s=$(stack_state "$n") owner=
      case "$s" in mine) owner=$(stack_root) ;; other:*) owner=${s#other:} ;; esac
      printf '%s  %-9s  https://localhost:80%s0  %s\n' "$n" "${s%%:*}" "$n" "$owner"
    done
    ;;
  *) echo "usage: $0 [up [N]|down|logs|ps|token|stacks]" >&2; exit 1 ;;
esac
