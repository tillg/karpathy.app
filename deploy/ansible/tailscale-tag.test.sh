#!/usr/bin/env bash
# Tests for the tailscale role's tag check (roles/tailscale/tasks/tag.yml): runs it on localhost against a fake
# `tailscale` that reports the node's tags.
# Run: bash deploy/ansible/tailscale-tag.test.sh (part of `just check`; needs ansible-playbook).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/tailscale" <<EOF
#!/usr/bin/env bash
[ "\$*" = "status --json" ] || { echo "fake tailscale: unexpected \$*" >&2; exit 99; }
printf '{"Self": {"DNSName": "karpathy-dev.example.ts.net.", "Tags": %s}}' "\$FAKE_TAGS"
EOF
chmod +x "$tmp/bin/tailscale"
cat >"$tmp/play.yml" <<'EOF'
- name: Tag check
  hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - name: The tailscale role's tag check
      ansible.builtin.include_role:
        name: tailscale
        tasks_from: tag
EOF

# check <tags json> <expected tag>: runs the check; sets $status and $out.
check() {
  out=$(cd "$here" && FAKE_TAGS="$1" PATH="$tmp/bin:$PATH" ANSIBLE_ROLES_PATH="$here/roles" ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i localhost, -e "tailscale_tag=$2 tailscale_hostname=karpathy-dev" "$tmp/play.yml" 2>&1)
  status=$?
}

check '["tag:server-dev"]' tag:server-dev
[ "$status" = 0 ] && ok "node has its tag: passes" || bad "node has its tag: passes" "$(tail -5 <<<"$out")"

check '["tag:other", "tag:server-dev"]' tag:server-dev
[ "$status" = 0 ] && ok "node has its tag among others: passes" || bad "node has its tag among others: passes" "$(tail -5 <<<"$out")"

check '["tag:server"]' tag:server-dev
[ "$status" != 0 ] && ok "node has the old tag: fails" || bad "node has the old tag: fails" "passed"
[[ "$out" == *"tag:server-dev"* && "$out" == *"Edit ACL tags"* ]] \
  && ok "… naming the wanted tag and the admin console" || bad "… naming the wanted tag and the admin console" "$(tail -5 <<<"$out")"

check 'null' tag:server-dev
[ "$status" != 0 ] && ok "node has no tags: fails" || bad "node has no tags: fails" "passed"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
