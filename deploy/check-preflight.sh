#!/usr/bin/env bash
# Before `just check`: the suite starts real containers with 30 s test timeouts. On a Mac busy with other stacks, or
# with Rancher Desktop down, it only times out after 20 minutes; say so up front instead.
# Run: bash deploy/check-preflight.sh (first step of `just check`); CHECK_IGNORE_LOAD=1 skips the load check.
set -uo pipefail

# preflight <load average (1 min)> <cores> <docker answers: 1|0>
preflight() {
  local load=$1 cores=$2 docker_ok=$3
  if [ "$docker_ok" != 1 ]; then
    echo "Docker doesn't answer: restart Rancher Desktop (rdctl shutdown && open -a \"Rancher Desktop\")" >&2
    return 1
  fi
  if awk -v l="$load" -v n="$cores" 'BEGIN { exit !(l > 3 * n) }'; then
    echo "load $load on $cores cores: the container tests would time out. Stop other stacks (just dev stacks) or wait;" \
      "CHECK_IGNORE_LOAD=1 runs anyway" >&2
    return 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  docker_ok=0
  docker info >/dev/null 2>&1 && docker_ok=1
  load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || true)
  [ -n "$load" ] || load=$(awk '{print $1}' /proc/loadavg)
  cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
  [ -n "${CHECK_IGNORE_LOAD:-}" ] && load=0
  preflight "$load" "$cores" "$docker_ok"
fi
