#!/usr/bin/env bash
# `just deploy <target> [version] [--only app|monitoring] [--bootstrap <public-ip>]` and `just deploy-check …` (check + diff).
# The version is X.Y.Z (no v); without one the app role takes the newest GitHub release.
# PLAYBOOK (default site.yml) picks another playbook: deploy/devhost.sh runs dev.yml this way.
set -euo pipefail
cd "$(dirname "$0")"
mode=$1 target=$2
shift 2
version="" tags=() bootstrap=
while [ $# -gt 0 ]; do
  case "$1" in
    --only) tags=(--tags "$2"); shift 2 ;;
    # First run against a fresh server: as root on its public IP. Afterwards: ops@<host> via Tailscale.
    --bootstrap) bootstrap=$2; shift 2 ;;
    -*) echo "unknown option $1" >&2; exit 1 ;;
    *) version=${1#v}; shift ;;  # 0.3.0 or v0.3.0
  esac
done
[ -d "inventories/$target" ] || { echo "unknown target: $target (have: $(ls inventories | xargs))" >&2; exit 1; }
args=(-i "inventories/$target" --vault-id "$target@vault-pass-client.sh" "${PLAYBOOK:-site.yml}" ${tags[@]+"${tags[@]}"})
[ -n "$version" ] && args+=(-e "app_version=$version")
if [ -n "$bootstrap" ]; then
  # ansible_host applies to every host: with more than one, they would all run against this IP.
  hosts=$(ansible-inventory -i "inventories/$target" --vault-id "$target@vault-pass-client.sh" --list </dev/null 2>/dev/null | jq -r '._meta.hostvars | keys | length')
  [ "$hosts" = 1 ] || { echo "--bootstrap needs exactly one host in inventories/$target, found $hosts" >&2; exit 1; }
  # A rebuilt server has a new host key under the old IP: forget the old one, accept the new one.
  ssh-keygen -R "$bootstrap" >/dev/null 2>&1 || true
  # JSON, not key=value: Ansible splits key=value at spaces and ssh would get a bare -o.
  args+=(-e "ansible_host=$bootstrap" -e ansible_user=root -e '{"ansible_ssh_common_args": "-o StrictHostKeyChecking=accept-new"}')
fi
[ "$mode" = check ] && args+=(--check --diff)
mkdir -p ../../tmp
log="../../tmp/deploy-$target-$(date +%Y%m%d-%H%M%S).log"
echo "log: tmp/${log##*/}"
ansible-playbook "${args[@]}" </dev/null 2>&1 | tee "$log"
