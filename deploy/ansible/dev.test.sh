#!/usr/bin/env bash
# Tests for deploy/ansible/dev.yml (the remote dev host): runs the playbook, without tailscale, against a fresh Ubuntu
# 24.04 container with systemd (privileged, so Docker runs inside), then checks the host it made.
# Run: bash deploy/ansible/dev.test.sh (part of `just check`; needs Docker and the internet, takes a few minutes).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

# Like a Hetzner Ubuntu image: only root (the base image's uid-1000 user goes), systemd, sshd, python3-debian.
image=karpathy-devhost-test
docker build -q -t "$image" - >/dev/null <<'EOF' || { echo "FAIL building the test image"; exit 1; }
FROM ubuntu:24.04
RUN userdel -r ubuntu && apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv python3 python3-debian sudo openssh-server ca-certificates curl >/dev/null \
  && rm -rf /var/lib/apt/lists/*
CMD ["/sbin/init"]
EOF
ctr=karpathy-devhost-test-$$
docker run -d --name "$ctr" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock -v /var/lib/docker "$image" >/dev/null || { echo "FAIL starting the test container"; exit 1; }
trap 'docker rm -f -v "$ctr" >/dev/null 2>&1' EXIT
for _ in $(seq 60); do
  case "$(docker exec "$ctr" systemctl is-system-running 2>/dev/null)" in running|degraded) break ;; esac
  sleep 1
done

user=dev
vars=$(cat <<EOF
{"target": "devtest", "tailscale_enabled": false, "timezone": "Europe/Berlin", "admin_user": "$user",
 "admin_authorized_keys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEz0bHnKXzR7hb0h7FVmJ0wXqZ8r7Yy1oGg0ZsVnQk2B devtest"],
 "devtools_host_secrets": {"openrouter_api_key": "or-test", "exa_api_key": "exa-test"}, "devtools_github_token": "gh-test",
 "devtools_git_user": {"name": "Dev Test", "email": "dev@example.invalid"}}
EOF
)
mkdir -p "$here/../../tmp"
log="$here/../../tmp/dev-test-$(date +%Y%m%d-%H%M%S).log"
echo "playbook log: tmp/${log##*/}"
if (cd "$here" && ansible-playbook -i "$ctr," -c community.docker.docker -e "$vars" dev.yml) >"$log" 2>&1 </dev/null; then
  ok "dev.yml runs against a fresh Ubuntu 24.04"
else
  bad "dev.yml runs against a fresh Ubuntu 24.04" "see $log"; tail -20 "$log"
fi

run() { docker exec "$ctr" "$@" 2>&1; }
as_user() { docker exec "$ctr" sudo -iu "$user" bash -lc "$1" 2>&1; }

# base: the login user is the app's uid, there is no deploy user.
eq "login user has uid 1000" "$(run id -u "$user")" 1000
eq "… and gid 1000" "$(run id -g "$user")" 1000
run id deploy >/dev/null && bad "no deploy user" "exists" || ok "no deploy user"
[[ " $(run id -nG "$user") " == *" docker "* ]] && ok "login user is in the docker group" || bad "login user is in the docker group" "$(run id -nG "$user")"
as_user 'sudo -n true' >/dev/null && ok "login user may sudo without a password" || bad "login user may sudo without a password" "refused"
as_user 'docker info >/dev/null' >/dev/null && ok "login user can use Docker" || bad "login user can use Docker" "$(as_user 'docker info' | tail -2)"

# devtools: what `just check`, `just dev up`, `just e2e` and `claude` need, on the login shell's PATH.
[[ "$(as_user 'node --version')" == v22.* ]] && ok "node is v22" || bad "node is v22" "$(as_user 'node --version')"
for tool in just rg jq gh claude ansible; do
  as_user "$tool --version" >/dev/null && ok "$tool answers --version" || bad "$tool answers --version" "$(as_user "$tool --version" | tail -1)"
done
# herdr's and tmux's panes are interactive non-login shells: they read ~/.bashrc, not ~/.profile.
out=$(docker exec -u "$user" -e HOME="/home/$user" -w "/home/$user" "$ctr" bash -ic 'command -v claude' 2>/dev/null)
[ -n "$out" ] && ok "claude is on the PATH of a non-login shell" || bad "claude is on the PATH of a non-login shell" "not found"
# Ubuntu's own just (1.21) can't parse the repo's justfile.
docker cp "$here/../../justfile" "$ctr:/tmp/justfile" >/dev/null
out=$(as_user 'just --justfile /tmp/justfile --summary') && ok "just parses the repo's justfile" || bad "just parses the repo's justfile" "$out"
as_user 'command -v nc' >/dev/null && ok "nc is installed" || bad "nc is installed" "missing"
pw=$(node -p "require('$here/../../package-lock.json').packages['node_modules/@playwright/test'].version")
eq "devtools' Playwright version is the repo's" "$(sed -n 's/^devtools_playwright_version: *//p' "$here/roles/devtools/defaults/main.yml" 2>/dev/null)" "$pw"
as_user 'ls -d ~/.cache/ms-playwright/chromium-*/' >/dev/null && ok "Playwright's Chromium is installed" || bad "Playwright's Chromium is installed" "missing"

# devtools: the host secrets every checkout falls back to (deploy/stack.sh secrets_from_host) and the git token.
for k in openrouter_api_key:or-test exa_api_key:exa-test; do
  f="~/.config/karpathy/secrets/${k%%:*}"
  eq "${k%%:*} in ~/.config/karpathy/secrets" "$(as_user "cat $f")" "${k#*:}"
  eq "… mode 600" "$(as_user "stat -c %a $f")" 600
done
eq "git credential for github.com returns the token" \
  "$(as_user "printf 'protocol=https\nhost=github.com\n\n' | git credential fill" | sed -n 's/^password=//p')" gh-test
eq "git user.name" "$(as_user 'git config --global user.name')" "Dev Test"
eq "git user.email" "$(as_user 'git config --global user.email')" "dev@example.invalid"

# devtools: inotify limits for several VS Code windows plus Vite, tsc and ESLint (docs/dev-server.md, "VS Code").
# The container shares the kernel, so applying them also raises the test machine's limits (only ever up).
conf=/etc/sysctl.d/60-karpathy-devtools.conf
out=$(run cat "$conf")
[[ "$out" == *"fs.inotify.max_user_instances = 1024"* && "$out" == *"fs.inotify.max_user_watches = 1048576"* ]] \
  && ok "inotify: sysctl.d file" || bad "inotify: sysctl.d file" "$out"
v=$(run sysctl -n fs.inotify.max_user_instances)
[ "$v" -ge 1024 ] 2>/dev/null && ok "inotify: max_user_instances ≥ 1024" || bad "inotify: max_user_instances ≥ 1024" "$v"
v=$(run sysctl -n fs.inotify.max_user_watches)
[ "$v" -ge 1048576 ] 2>/dev/null && ok "inotify: max_user_watches ≥ 1048576" || bad "inotify: max_user_watches ≥ 1048576" "$v"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
