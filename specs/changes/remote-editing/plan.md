---
feature: remote-editing
title: "Plan: edit code on the dev server from the Mac's VS Code"
status: applied
order: 4
created: 2026-10-21
edited: 2026-10-21
---

# Plan: edit code on the dev server from the Mac's VS Code

## Dev server

- [x] `devtools` raises the inotify limits: `/etc/sysctl.d/60-karpathy-devtools.conf` with `fs.inotify.max_user_instances = 1024` and `fs.inotify.max_user_watches = 1048576`, applied by a handler (`sysctl --system`)
  - Depends on: none
  - Test first: `deploy/ansible/dev.test.sh` › "inotify: sysctl.d file" (the file holds both lines) › "inotify: max_user_instances ≥ 1024" › "inotify: max_user_watches ≥ 1048576" (`sysctl -n` in the container). Fails today because the role sets neither (128 / 243 651 on `karpathy-dev`)
  - Verify: `bash deploy/ansible/dev.test.sh` → all ok; `ansible-playbook --syntax-check deploy/ansible/dev.yml`

## Workspace

- [x] Committed workspace settings: `.vscode/settings.json` (the nine forwarded stack ports 8010…8090, each `onAutoForward: ignore`, no range; `files.watcherExclude` and `search.exclude` as in architecture.md) and `.vscode/extensions.json` (ESLint, Playwright Test, Vitest, Claude Code, Ansible, `just` syntax)
  - Depends on: none
  - Test first: none, config only. Verify is the mechanical check
  - Verify: `jq -e '(.["remote.portsAttributes"] | keys) == ["8010","8020","8030","8040","8050","8060","8070","8080","8090"] and ([.["remote.portsAttributes"][].onAutoForward] | all(. == "ignore")) and .["files.watcherExclude"]["**/.worktrees/**"] and .["files.watcherExclude"]["**/tmp/**"] and .["search.exclude"]["**/.worktrees"]' .vscode/settings.json && jq -e '.recommendations | index("dbaeumer.vscode-eslint") and index("ms-playwright.playwright") and index("vitest.explorer") and index("anthropic.claude-code") and index("redhat.ansible") and index("nefrob.vscode-just-syntax")' .vscode/extensions.json`; `git check-ignore -q .vscode/settings.json` fails (tracked)

## Mac

- [x] `just code [worktree]` via `deploy/code.sh`: opens `code --remote ssh-remote+$KARPATHY_DEVHOST $KARPATHY_DEVHOST_CHECKOUT[/.worktrees/<worktree>]` (defaults `karpathy-dev`, `/home/$USER/karpathy.app`); refuses to run on the dev host itself (`hostname -s` = `$KARPATHY_DEVHOST`) with the hint "run on the Mac; here use `code .worktrees/x`"; refuses a worktree that isn't one path segment; stops with the "Install 'code' command in PATH" hint when `code` is missing
  - Depends on: none
  - Test first: `deploy/code.test.sh` with a stub `code` on the `PATH` that records its arguments › "no argument opens the main clone" › "a worktree opens .worktrees/NAME" › "KARPATHY_DEVHOST and KARPATHY_DEVHOST_CHECKOUT override the defaults" › "a/b and .. are refused, code not called" › "on the dev host (stub `hostname -s` prints `$KARPATHY_DEVHOST`): exit 1, the hint, code not called" › "without code on the PATH: exit 1 and the hint". Fails today because `deploy/code.sh` doesn't exist
  - Verify: `bash deploy/code.test.sh` → all ok; `just --show code`; `just check` green (it runs `code.test.sh`)

## Docs

- [x] Document VS Code on the dev server: a "VS Code" section in `docs/dev-server.md` (Mac setup: VS Code, the Remote-SSH extension, the `code` CLI, `remote.SSH.remotePlatform` `karpathy-dev: linux`; `just code [worktree]`; one window per checkout; the nine stack ports stay on the SSH entry's forward, prodtest's 80N5 and `just site`'s 8099 come through VS Code's own forward (only from a VS Code window, not from herdr); `just code` refuses on the server, use `code .worktrees/x` there; herdr/tmux for long runs; troubleshooting: "unable to watch for file changes", a forward taken by another connection, a missing worktree folder), VS Code in the picture and the table, and pointers in `deploy/README.md` › Dev server and in `CLAUDE.md`
  - Depends on: 1, 2, 3
  - Test first: none, docs only
  - Verify: `grep -q '## VS Code' docs/dev-server.md && grep -q 'just code' docs/dev-server.md deploy/README.md CLAUDE.md && grep -q 'max_user_instances' docs/dev-server.md`

## Smoke test

- [x] Smoke test from the Mac against `karpathy-dev`
  - Depends on: 1, 2, 3, 4
  - Test first: none, needs the Mac and the server
  - Verify: on the Mac: `just devhost` applies the sysctl (`ssh karpathy-dev sysctl -n fs.inotify.max_user_instances` → 1024); `just code` opens a window on `~/karpathy.app` and offers the six extensions; ESLint marks a deliberate lint error inline; `just dev up` in its terminal → the Ports view shows no auto-forwarded 80N0, and https://localhost:80N0 on the Mac loads with live reload after a `.tsx` edit; `just prodtest` in the same terminal → the Ports view shows 80N5 forwarded to the Mac's 80N5, and https://localhost:80N5 loads; the Testing view lists the Vitest tests; `just code <worktree>` opens a second window at the same time, with no "unable to watch" warning in either; `claude` runs in the terminal and the Claude Code extension answers in the panel; `git commit` from the Source Control view uses the server's identity

System docs are updated at `/spec:archive`.
