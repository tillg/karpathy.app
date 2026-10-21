---
feature: remote-editing
title: "Plan: edit code on the dev server from the Mac's VS Code"
status: proposed
order: 4
created: 2026-10-21
edited: 2026-10-21
---

# Plan: edit code on the dev server from the Mac's VS Code

## Dev server

- [ ] `devtools` raises the inotify limits: `/etc/sysctl.d/60-karpathy-devtools.conf` with `fs.inotify.max_user_instances = 1024` and `fs.inotify.max_user_watches = 1048576`, applied by a handler (`sysctl --system`)
  - Depends on: none
  - Test first: `deploy/ansible/dev.test.sh` › "inotify: sysctl.d file" (the file holds both lines) › "inotify: max_user_instances ≥ 1024" › "inotify: max_user_watches ≥ 1048576" (`sysctl -n` in the container). Fails today because the role sets neither (128 / 243 651 on `karpathy-dev`)
  - Verify: `bash deploy/ansible/dev.test.sh` → all ok; `ansible-playbook --syntax-check deploy/ansible/dev.yml`

## Workspace

- [ ] Committed workspace settings: `.vscode/settings.json` (stack ports 8000–8099 `onAutoForward: ignore`; `files.watcherExclude` and `search.exclude` as in architecture.md) and `.vscode/extensions.json` (ESLint, Playwright Test, Claude Code, Ansible, `just` syntax)
  - Depends on: none
  - Test first: none, config only. Verify is the mechanical check
  - Verify: `jq -e '.["remote.portsAttributes"]["8000-8099"].onAutoForward == "ignore" and .["files.watcherExclude"]["**/.worktrees/**"] and .["files.watcherExclude"]["**/tmp/**"] and .["search.exclude"]["**/.worktrees"]' .vscode/settings.json && jq -e '.recommendations | index("dbaeumer.vscode-eslint") and index("ms-playwright.playwright") and index("anthropic.claude-code") and index("redhat.ansible") and index("nefrob.vscode-just-syntax")' .vscode/extensions.json`; `git check-ignore -q .vscode/settings.json` fails (tracked)

## Mac

- [ ] `just code [worktree]` via `deploy/code.sh`: opens `code --remote ssh-remote+$KARPATHY_DEVHOST $KARPATHY_DEVHOST_CHECKOUT[/.worktrees/<worktree>]` (defaults `karpathy-dev`, `/home/$USER/karpathy.app`); refuses a worktree that isn't one path segment; stops with the "Install 'code' command in PATH" hint when `code` is missing
  - Depends on: none
  - Test first: `deploy/code.test.sh` with a stub `code` on the `PATH` that records its arguments › "no argument opens the main clone" › "a worktree opens .worktrees/NAME" › "KARPATHY_DEVHOST and KARPATHY_DEVHOST_CHECKOUT override the defaults" › "a/b and .. are refused, code not called" › "without code on the PATH: exit 1 and the hint". Fails today because `deploy/code.sh` doesn't exist
  - Verify: `bash deploy/code.test.sh` → all ok; `just --show code`; `just check` green (it runs `code.test.sh`)

## Docs

- [ ] Document VS Code on the dev server: a "VS Code" section in `docs/dev-server.md` (Mac setup: VS Code, the Remote-SSH extension, the `code` CLI, `remote.SSH.remotePlatform` `karpathy-dev: linux`; `just code [worktree]`; one window per checkout; ports stay on the SSH entry's forward; herdr/tmux for long runs; troubleshooting: "unable to watch for file changes", a forward taken by another connection, a missing worktree folder), VS Code in the picture and the table, and pointers in `deploy/README.md` › Dev server and in `CLAUDE.md`
  - Depends on: 1, 2, 3
  - Test first: none, docs only
  - Verify: `grep -q '## VS Code' docs/dev-server.md && grep -q 'just code' docs/dev-server.md deploy/README.md CLAUDE.md && grep -q 'max_user_instances' docs/dev-server.md`

## Smoke test

- [ ] Smoke test from the Mac against `karpathy-dev`
  - Depends on: 1, 2, 3, 4
  - Test first: none, needs the Mac and the server
  - Verify: on the Mac: `just devhost` applies the sysctl (`ssh karpathy-dev sysctl -n fs.inotify.max_user_instances` → 1024); `just code` opens a window on `~/karpathy.app` and offers the five extensions; ESLint marks a deliberate lint error inline; `just dev up` in its terminal → the Ports view shows no auto-forwarded 80N0, and https://localhost:80N0 on the Mac loads with live reload after a `.tsx` edit; `just code <worktree>` opens a second window at the same time, with no "unable to watch" warning in either; `claude` runs in the terminal and the Claude Code extension answers in the panel; `git commit` from the Source Control view uses the server's identity

System docs are updated at `/spec:archive`.
