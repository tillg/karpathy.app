#!/usr/bin/env bash
# `just code [worktree]`, on the Mac: opens a VS Code window on the remote dev host through Remote-SSH, on the main
# clone or on .worktrees/<worktree> (docs/dev-server.md, "VS Code"). Host and checkout from KARPATHY_DEVHOST
# (default karpathy-dev) and KARPATHY_DEVHOST_CHECKOUT (default /home/$USER/karpathy.app).
# `just code-web [worktree]` (--web): the same checkout in the browser editor (code-server) at KARPATHY_DEVHOST_URL;
# on the Mac in the default browser, on the dev host as a URL and a QR code for the iPad (docs/dev-server.md, "iPad").
set -euo pipefail
host=${KARPATHY_DEVHOST:-karpathy-dev}
checkout=${KARPATHY_DEVHOST_CHECKOUT:-/home/$USER/karpathy.app}
url=${KARPATHY_DEVHOST_URL:-https://karpathy-dev.tailab154c.ts.net}
web=
if [ "${1:-}" = --web ]; then
  web=1
  shift
fi
worktree=${1:-}

case "$worktree" in
  */* | . | ..) echo "just code: '$worktree' is not a worktree name (a worktree name, not a path)" >&2; exit 1 ;;
esac
folder="$checkout${worktree:+/.worktrees/$worktree}"

if [ -n "$web" ]; then
  link="$url/?folder=$folder"
  if [ "$(hostname -s)" = "$host" ]; then
    echo "$link"
    qrencode -t ansiutf8 "$link"
  else
    open "$link"
  fi
  exit 0
fi

if [ "$(hostname -s)" = "$host" ]; then
  echo "just code: run on the Mac; here use code .worktrees/${worktree:-<name>}" >&2
  exit 1
fi
if ! command -v code >/dev/null; then
  echo "just code: no 'code' on the PATH. In VS Code: Command Palette › Shell Command: Install 'code' command in PATH" >&2
  exit 1
fi

exec code --remote "ssh-remote+$host" "$folder"
