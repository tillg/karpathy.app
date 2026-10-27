#!/usr/bin/env bash
# Tests for deploy/ansible/worker-token.sh (`just instagram-worker-token <target>`): a stub `ssh` on the PATH, the
# script copied into a fake checkout so `dev` and `prodtest` read its secrets.
# Run: bash deploy/ansible/worker-token.test.sh (part of `just check`).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/repo/deploy/ansible" "$tmp/repo/deploy/secrets" "$tmp/repo/tmp/prodtest/secrets"
cp "$here/worker-token.sh" "$tmp/repo/deploy/ansible/"
script="$tmp/repo/deploy/ansible/worker-token.sh"
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$tmp/ssh-args"
echo wt-hetzner
STUB
chmod +x "$tmp/bin/ssh"
printf 'wt-dev\n' >"$tmp/repo/deploy/secrets/ingest_worker_token"
printf 'wt-prodtest\n' >"$tmp/repo/tmp/prodtest/secrets/ingest_worker_token"
run() { PATH="$tmp/bin:$PATH" bash "$script" "$@" 2>&1; }

eq "dev prints deploy/secrets/ingest_worker_token" "$(run dev)" wt-dev
eq "prodtest prints tmp/prodtest/secrets/ingest_worker_token" "$(run prodtest)" wt-prodtest
eq "hetzner prints what ssh returns" "$(run hetzner)" wt-hetzner
eq "hetzner runs ssh ops@karpathy sudo cat …/shared/secrets/ingest_worker_token" "$(cat "$tmp/ssh-args" 2>/dev/null)" \
  "$(printf '%s\n' ops@karpathy 'sudo cat /opt/karpathy.app/shared/secrets/ingest_worker_token')"
out=$(run staging); rc=$?
eq "an unknown target fails" "$rc" 1
[[ "$out" == *"dev, prodtest, hetzner"* ]] && ok "… with the list" || bad "… with the list" "$out"
rm "$tmp/repo/deploy/secrets/ingest_worker_token"
out=$(run dev); rc=$?
eq "dev without the secret fails" "$rc" 1
[[ "$out" == *"just dev up"* ]] && ok "… pointing at just dev up" || bad "… pointing at just dev up" "$out"

[ "$fails" -eq 0 ] || { echo "$fails failed"; exit 1; }
echo "worker-token.test.sh: ok"
