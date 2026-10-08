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

# Compose reads the settings rendered from deploy/settings/ (just settings render), for dev and prodtest.
(
  fails=0
  dir=$(mktemp -d); out=$(mktemp -d); store=$(mktemp -d)
  cp "$here"/settings/*.yaml "$dir"/ && rm -f "$dir"/*.local.yaml
  # A key with characters an env file could mangle.
  printf 'ai: { gateway: openrouter, model: openrouter/z-ai/glm-5.3 }\n' | tee "$dir/dev.local.yaml" > "$dir/prodtest.local.yaml"
  printf 't' > "$store/bearer_token"; printf 'p' > "$store/opencode_password"; printf '%s' 'sk-or-#1 "x" $y' > "$store/openrouter_api_key"
  for env in dev prodtest; do
    "$here/../node_modules/.bin/tsx" "$here/../packages/settings/src/cli.ts" render "$env" --dir "$dir" --out "$out/$env" --secrets "$store" --compose-dir "$here" \
      || { bad "render $env" "failed"; continue; }
    f=$([ "$env" = dev ] && echo compose.dev.yml || echo compose.prodtest.yml)
    cfg=$(cd "$here" && STACK=1 PROXY_PORT=8010 BACKEND_PORT=8011 PRODTEST_PORT=8015 \
      docker compose -f compose.yml -f "$f" --env-file "$out/$env/.env" config --format json 2>&1) || { bad "compose config $env" "$cfg"; continue; }
    get() { node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=(new Function("c","return "+process.argv[1]))(c); console.log(typeof v==="string"?v:JSON.stringify(v))' "$1" <<<"$cfg"; }
    eq "$env: backend has SETTINGS_FILE" "$(get 'c.services.backend.environment.SETTINGS_FILE')" /etc/karpathy/settings.json
    eq "$env: backend mounts the rendered settings.json" "$(get 'c.services.backend.volumes.find(v=>v.target==="/etc/karpathy/settings.json").source')" "$out/$env/settings.json"
    # OPENCODE_CONFIG_CONTENT is merged after a vault's own opencode.json (OPENCODE_CONFIG before it), so a vault
    # can't turn off the ZDR routing or point the gateway elsewhere.
    eq "$env: opencode gets the providers as OPENCODE_CONFIG_CONTENT" "$(get 'JSON.parse(c.services.opencode.environment.OPENCODE_CONFIG_CONTENT).provider.openrouter.models["z-ai/glm-5.3"].options.provider.zdr')" true
    eq "$env: … and no OPENCODE_CONFIG file a vault could override" "$(get 'c.services.opencode.environment.OPENCODE_CONFIG ?? "unset"')" unset
    # Compared, never printed: a wrong compose file could hand over a real key. `config` prints $ as $$ (the
    # container gets $y).
    eq "$env: opencode.env key survives verbatim" "$(get 'c.services.opencode.environment.OPENROUTER_API_KEY===`sk-or-#1 "x" $$y`')" true
    eq "$env: model from the settings" "$(get 'c.services.opencode.environment.OPENCODE_MODEL')" openrouter/z-ai/glm-5.3
    relay=$([ "$env" = dev ] && echo ollama || echo ollama-bridge)
    eq "$env: the Ollama relay's upstream from the settings" "$(get "c.services[\"$relay\"].environment.OLLAMA_UPSTREAM")" host.docker.internal:11434
  done
  rm -rf "$dir" "$out" "$store"
  exit "$fails"
) || fails=$((fails + 1))
if grep -nE 'qwen|claude-sonnet|glm-5' "$here"/compose*.yml; then bad "no model literal in compose files" "found"; else ok "no model literal in compose files"; fi

# dev.sh and `just prodtest` render the settings first and refuse the pre-settings deploy/.env and opencode.env.
(
  fails=0
  source "$here/stack.sh"
  c=$(checkout); cd "$c" || exit 1
  mkdir -p deploy && printf 'DEFAULT_MODEL=x/y\n# a comment\nGIT_AUTHOR_NAME=Secret Name\n' > deploy/.env
  printf 'OPENROUTER_API_KEY=sk-SECRET\n' > deploy/opencode.env
  out=$(settings_legacy_check 2>&1); rc=$?
  eq "legacy deploy/.env and opencode.env stop the start" "$rc" 1
  [[ "$out" == *DEFAULT_MODEL* && "$out" == *OPENROUTER_API_KEY* && "$out" == *settings/dev.local.yaml* ]] \
    && ok "… naming each key and where it goes" || bad "… naming each key and where it goes" "$out"
  [[ "$out" != *SECRET* && "$out" != *x/y* ]] && ok "… never their values" || bad "… never their values" "leaked"
  rm deploy/.env deploy/opencode.env
  settings_legacy_check >/dev/null 2>&1 && ok "no legacy files → go" || bad "no legacy files → go" "refused"
  cd / && rm -rf "$c"
  store=$(mktemp -d); out=$(mktemp -d)
  settings_render dev "$store" "$out/dev" --no-local >/dev/null 2>&1; rc=$?
  eq "render without the required secrets fails" "$rc" 1
  printf 't' > "$store/bearer_token"; printf 'p' > "$store/opencode_password"
  settings_render dev "$store" "$out/dev" --no-local >/dev/null 2>&1 && [ -s "$out/dev/settings.json" ] \
    && ok "render writes the settings" || bad "render writes the settings" "no settings.json"
  rm -rf "$store" "$out"
  exit "$fails"
) || fails=$((fails + 1))
grep -q 'settings_render dev' "$here/dev.sh" && grep -q 'settings_legacy_check' "$here/dev.sh" \
  && ok "dev.sh up renders and checks for legacy files" || bad "dev.sh up renders and checks for legacy files" "missing"
grep -q 'settings_render prodtest' "$here/../justfile" && ok "just prodtest renders" || bad "just prodtest renders" "missing"

# Ansible (role app) renders a target's settings on the controller: render-settings.sh takes the target's secrets
# as JSON on stdin (name → value), never as arguments, and removes them again.
(
  fails=0
  out=$(mktemp -d)
  printf '{"bearer_token":"tok-SECRET","github_token":"","dns_api_token":"d:SECRET","git_author_name":"Jane","git_author_email":"j@x","openrouter_api_key":"or-SECRET"}' \
    | "$here/ansible/render-settings.sh" hetzner "$out" > "$out.log" 2>&1; rc=$?
  eq "render-settings.sh hetzner exits 0" "$rc" 0
  for f in .env opencode.env settings.json; do
    [ -s "$out/$f" ] && ok "… writes $f" || bad "… writes $f" "missing"
  done
  grep -q '^OPENROUTER_API_KEY=or-SECRET$' "$out/opencode.env" && ok "… the key reaches opencode.env" || bad "… the key reaches opencode.env" "no"
  grep -q '^GIT_AUTHOR_NAME=Jane$' "$out/.env" && ok "… the vault's author reaches .env" || bad "… the vault's author reaches .env" "no"
  ! grep -q SECRET "$out.log" && ok "… prints no secret" || bad "… prints no secret" "leaked"
  [ -z "$(ls -A "$out" | grep -v -e '^\.env$' -e '^opencode.env$' -e '^settings.json$')" ] \
    && ok "… leaves no secret store behind" || bad "… leaves no secret store behind" "$(ls -A "$out")"
  printf '{"bearer_token":"t"}' | "$here/ansible/render-settings.sh" hetzner "$out/2" >/dev/null 2>&1 \
    && bad "a missing required secret fails" "rc 0" || ok "a missing required secret fails"
  [ ! -e "$out/2.secrets" ] && ok "… and cleans up" || bad "… and cleans up" "store left"
  rm -rf "$out" "$out.log"
  exit "$fails"
) || fails=$((fails + 1))

# Every secret a target's settings use has a source in role app: named in roles/app/vars/main.yml, a provider
# key from vault_opencode_env (<NAME>_API_KEY → <name>_api_key), or the opencode password made on the host.
for t in local hetzner; do
  missing=$("$here/../node_modules/.bin/tsx" "$here/../packages/settings/src/cli.ts" --no-local --list-secrets "$t" | while read -r name; do
    case "$name" in (opencode_password|*_api_key) continue ;; esac
    grep -q "'$name'" "$here/ansible/roles/app/vars/main.yml" || echo "$name"
  done)
  eq "$t: every secret in the settings has a source in role app" "$missing" ""
done

# A target's compose.target.yml: the Ollama relay only when deploy/settings/ picks the Ollama gateway.
(
  fails=0
  out=$(mktemp -d)
  tpl=${TARGET_TEMPLATE:-$here/ansible/roles/app/templates/compose.target.yml.j2}
  ANSIBLE_LOCALHOST_WARNING=False ansible localhost -m template -a "src=$tpl dest=$out/local.yml" \
    -e '{"target":"local","remotes_dir":"/remotes","vaults_fs_mount":"/srv/vaults","app_settings_env":{"OLLAMA_UPSTREAM":"192.168.5.2:11434","GIT_REMOTE_BASE":"file:///remotes/"}}' >/dev/null 2>&1
  ANSIBLE_LOCALHOST_WARNING=False ansible localhost -m template -a "src=$tpl dest=$out/hetzner.yml" \
    -e '{"target":"hetzner","vaults_fs_mount":"/srv/vaults","app_settings_env":{}}' >/dev/null 2>&1
  for t in local hetzner; do
    cfg=$(cd "$here" && OLLAMA_UPSTREAM=192.168.5.2:11434 docker compose -f compose.yml -f "$out/$t.yml" config --format json 2>&1) \
      || { bad "$t: compose.target.yml merges" "$cfg"; continue; }
    has=$(node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); const r=c.services["ollama-relay"]; console.log(r ? `${r.environment.OLLAMA_UPSTREAM} ${c.services.opencode.environment.NO_PROXY}` : "none")' <<<"$cfg")
    if [ "$t" = local ]; then
      eq "local: relay to the Mac's Ollama, opencode reaches it direct" "$has" "192.168.5.2:11434 localhost,127.0.0.1,0.0.0.0,ollama.internal"
      eq "local: older releases still get GIT_REMOTE_BASE (rollback)" "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).services.backend.environment.GIT_REMOTE_BASE)' <<<"$cfg")" file:///remotes/
    else
      eq "hetzner: no relay" "$has" none
    fi
  done
  rm -rf "$out"
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
