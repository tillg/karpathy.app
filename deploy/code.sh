#!/usr/bin/env bash
# `just code [worktree]`, on the Mac: opens a VS Code window on the remote dev host through Remote-SSH, on the main
# clone or on .worktrees/<worktree> (docs/dev-server.md, "VS Code"). Host and checkout from KARPATHY_DEVHOST
# (default karpathy-dev) and KARPATHY_DEVHOST_CHECKOUT (default /home/$USER/karpathy.app).
set -euo pipefail
host=${KARPATHY_DEVHOST:-karpathy-dev}
checkout=${KARPATHY_DEVHOST_CHECKOUT:-/home/$USER/karpathy.app}
worktree=${1:-}

if [ "$(hostname -s)" = "$host" ]; then
  echo "just code: run on the Mac; here use code .worktrees/${worktree:-<name>}" >&2
  exit 1
fi
case "$worktree" in
  */* | . | ..) echo "just code: '$worktree' is not a worktree name (a worktree name, not a path)" >&2; exit 1 ;;
esac
if ! command -v code >/dev/null; then
  echo "just code: no 'code' on the PATH. In VS Code: Command Palette › Shell Command: Install 'code' command in PATH" >&2
  exit 1
fi

exec code --remote "ssh-remote+$host" "$checkout${worktree:+/.worktrees/$worktree}"
