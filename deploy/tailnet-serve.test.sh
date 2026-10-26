#!/usr/bin/env bash
# Tests for deploy/tailnet-serve.sh: a fake `tailscale` on the PATH answers `status --json` and `serve status --json`
# from fixture files and logs every call.
# Run: bash deploy/tailnet-serve.test.sh (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# FAKE_SERVE_RC: exit code of `serve --bg …` (default 0).
cat >"$tmp/bin/tailscale" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$tmp/calls"
case "\$*" in
  "status --json") cat "$tmp/status.json" ;;
  "serve status --json") cat "$tmp/serve.json" ;;
  serve\ --bg*) [ "\${FAKE_SERVE_RC:-0}" = 0 ] || { echo "serve refused" >&2; exit "\$FAKE_SERVE_RC"; } ;;
  *) echo "fake tailscale: unexpected \$*" >&2; exit 99 ;;
esac
EOF
chmod +x "$tmp/bin/tailscale"

https_on='{"CertDomains": ["node.example.ts.net"], "Self": {"DNSName": "node.example.ts.net."}}'
https_off='{"CertDomains": null, "Self": {"DNSName": "node.example.ts.net."}}'
served() {  # served <port> <target>: a serve config with <port>'s / proxied to <target>
  printf '{"TCP": {"%s": {"HTTPS": true}}, "Web": {"node.example.ts.net:%s": {"Handlers": {"/": {"Proxy": "%s"}}}}}' \
    "$1" "$1" "$2"
}

# run <status json> <serve json> [env…] -- <args…>: prints the script's output, sets $status.
run() {
  printf '%s' "$1" >"$tmp/status.json"
  printf '%s' "$2" >"$tmp/serve.json"
  shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  rm -f "$tmp/calls"
  out=$(env PATH="$tmp/bin:$PATH" ${envs[@]+"${envs[@]}"} bash "$here/tailnet-serve.sh" "$@" 2>&1)
  status=$?
}
serve_calls() { grep '^serve --bg' "$tmp/calls" 2>/dev/null; }

run "$https_off" '{}' -- 443 http://127.0.0.1:8080
eq "HTTPS off: exit 3" "$status" 3
[[ "$out" == *"HTTPS Certificates"* ]] && ok "HTTPS off: names the admin console switch" || bad "HTTPS off: names the admin console switch" "$out"
eq "HTTPS off: no serve call" "$(serve_calls)" ""

run "$https_on" "$(served 443 http://127.0.0.1:8080)" -- 443 http://127.0.0.1:8080
eq "already served: exit 0" "$status" 0
eq "already served: unchanged" "$out" unchanged
eq "already served: no serve call" "$(serve_calls)" ""

run "$https_on" '{}' -- 443 http://127.0.0.1:8080
eq "nothing served: exit 0" "$status" 0
eq "nothing served: changed" "$out" changed
eq "nothing served: serve call" "$(serve_calls)" "serve --bg --https=443 http://127.0.0.1:8080"

run "$https_on" "$(served 443 http://127.0.0.1:9999)" -- 443 http://127.0.0.1:8080
eq "other target on the port: changed" "$out" changed
eq "other target on the port: serve call" "$(serve_calls)" "serve --bg --https=443 http://127.0.0.1:8080"

run "$https_on" "$(served 8010 https+insecure://localhost:8010)" -- 443 http://127.0.0.1:8080
eq "another port served: changed" "$out" changed
eq "another port served: only this port's serve call" "$(serve_calls)" "serve --bg --https=443 http://127.0.0.1:8080"
[[ "$(cat "$tmp/calls" 2>/dev/null)" != *"off"* && "$(cat "$tmp/calls" 2>/dev/null)" != *"reset"* ]] \
  && ok "another port served: left alone" || bad "another port served: left alone" "$(cat "$tmp/calls")"

run "$https_on" '{}' FAKE_SERVE_RC=1 -- 443 http://127.0.0.1:8080
eq "serve fails: exit 1" "$status" 1
[[ "$out" == *"serve refused"* ]] && ok "serve fails: shows tailscale's output" || bad "serve fails: shows tailscale's output" "$out"

run "$https_on" '{}' -- 443
eq "missing target: exit 2" "$status" 2

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
