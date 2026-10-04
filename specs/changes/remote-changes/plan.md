---
feature: remote-changes
title: "Plan: background fetch, incoming count and the user's pull"
status: proposed
order: 4
created: 2026-10-04
edited: 2026-10-04
---

# Plan: background fetch, incoming count and the user's pull

Each step is one red → green cycle. Nothing is mocked: git runs for real against local bare remotes.

- **Backend:** vitest. `apps/backend/test/repo.test.ts` (a `Repo` on a clone of `makeRemote`), `lock.test.ts`
  (`VaultLock` alone), `api.test.ts` (the real app via `vaultApp()`, "Obsidian" pushes with
  `remote.obsidianPush`, offline by renaming `remote.bare`): `npm test -w apps/backend -- <file>`.
- **e2e:** Playwright against the dev stack (`just dev` running): `just e2e <spec>`. Obsidian pushes with
  `pushFromObsidian(vault.bare, …)`, offline with `breakRemote`. A connect (and so a fetch) is triggered with
  `page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))`: the page is visible, so
  `useVaultEvents` reconnects. A reload would not do: the open's pull would take the commit in first.
- **Full suite:** `just check` (lint, typecheck, unit and integration tests).

## Phase 1: count and fetch in the repo

- [ ] `Repo.incomingCount()` counts GitHub's commits not in HEAD
  - Test first: `repo.test.ts` › "incomingCount counts fetched commits on GitHub's side only". Clone, Obsidian
    pushes 2 commits, `repo.git.run(['fetch', 'origin', 'main'])`: `incomingCount()` is 2. Then commit one local
    change (no push): `incomingCount()` still 2, `unpushedCount()` 1. Fails today: the method doesn't exist.
  - Verify: `npm test -w apps/backend -- repo` → green.

- [ ] The count is scoped to the vault root
  - Test first: `repo.test.ts` › "incomingCount ignores commits outside a subfolder vault root". Remote with
    `wiki/a.md` and `outside.md`, `Repo` with root `wiki`; Obsidian pushes a change to `outside.md`, fetch:
    count 0; pushes a change to `wiki/a.md`, fetch: count 1. Fails until the pathspec is passed.
  - Verify: `npm test -w apps/backend -- repo` → green.

- [ ] `Repo.fetchUpstream()` moves only `origin/<branch>`
  - Test first: `repo.test.ts` › "fetchUpstream updates the remote ref and nothing else". Local uncommitted edit of
    `a.md` plus one unpushed commit; Obsidian pushes `b.md`. After `fetchUpstream()`: `{ ok: true }`,
    `incomingCount()` 1, `changes()` and `unpushedCount()` unchanged, `b.md` on disk still the old text. Then rename
    the bare repo away: `{ ok: false, error }` with a non-empty error, count still 1. Fails today: no such method.
  - Verify: `npm test -w apps/backend -- repo` → green.

## Phase 2: lock and vault

- [ ] `VaultLock.tryShared('fetch')` never waits and never shows as busy
  - Test first: `lock.test.ts` › "tryShared grants next to shared holders, refuses while exclusive holds or waits".
    Free lock → granted, `busy` `none`. With a `turn` holder → granted, `busy` `turn`. With an exclusive held → null.
    With a `save` holder and an exclusive queued → null. With a `fetch` holder, `acquireExclusive()` resolves only
    after the fetch releases. Fails today: no `tryShared`, no `fetch` label.
  - Verify: `npm test -w apps/backend -- lock` → green.

- [ ] `VaultStatus.incomingCount` is reported
  - Test first: `api.test.ts` › "status reports incoming commits after a fetch, files untouched". `vaultApp()`,
    `obsidianPush({'Other.md': 'remote v2\n'})`, `await t.vaults.fetchRemote(t.id)` → `'fetched'`;
    `GET /status` has `incomingCount: 1`; `GET /file?path=Other.md` still `other\n`. A fresh vault reports
    `incomingCount: 0`. Fails today: no field, no `fetchRemote`. (Adds the field to `packages/shared`.)
  - Verify: `npm test -w apps/backend -- api` → green; `npm run typecheck` → green.

- [ ] `fetchRemote` runs during an AI turn and skips git operations
  - Test first: `api.test.ts` › "background fetch runs next to a turn, skips while a git op holds the lock". Hold
    `acquireShared('turn')`, Obsidian pushes, `fetchRemote` → `'fetched'`, status `incomingCount: 1`,
    `busy: 'turn'`. Hold `acquireExclusive()` instead: `fetchRemote` → `'skipped'` without waiting. Two calls at
    once return the same promise. Fails today: no lock rules in `fetchRemote`.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] A failed fetch sets `pullError` and keeps the count; a good one clears it
  - Test first: `api.test.ts` › "offline background fetch keeps the last count and reports pullError". Obsidian
    pushes, `fetchRemote` → count 1. Rename `remote.bare` away: `fetchRemote` → `'offline'`, status `pullError` set
    and without the token text, `incomingCount` still 1. Rename back: `'fetched'`, `pullError` gone. Fails today:
    fetch errors aren't recorded.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] The pull on open waits for a running background fetch
  - Test first: `api.test.ts` › "open pulls even while a background fetch runs". Obsidian pushes, start
    `fetchRemote` without awaiting it, `POST /open` → `Other.md` is `remote v2\n` and `incomingCount: 0`. Fails
    today: `tryExclusive` sees the `fetch` holder and skips the pull.
  - Verify: `npm test -w apps/backend -- api` → green; the existing "pull on open … skipped while a shared holder
    runs" stays green.

- [ ] The event stream drives the schedule
  - Test first: `api.test.ts`, `describe('event stream')` › "connect fetches, the interval fetches while
    connected, nothing after disconnect". App with `fetchIntervalMs: 200` (new `makeApp` option passed to
    `VaultsEnv`). Obsidian pushes before connecting: the first events include a `status` with `incomingCount: 1`
    within 1 s. Obsidian pushes again: a `status` with `incomingCount: 2` within 1 s. Abort the stream and wait one interval (250 ms, so
    a fetch started before the abort has finished), then Obsidian pushes again, wait 1 s: `GET /status` still
    `incomingCount: 2` (no fetch ran). Connect again, `DELETE` the vault while the stream is open, wait 1 s: no
    unhandled rejection (vitest fails on one). Fails today: nothing fetches.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] `POST /vaults/:id/pull` runs the existing pull
  - Test first: `api.test.ts` › "pull route: takes incoming commits, waits for a turn, refuses in conflict". Obsidian
    pushes, `fetchRemote`, `POST /pull` → 200, `incomingCount: 0`, `Other.md` is `remote v2\n`. With a `turn`
    holder: the request doesn't finish within 200 ms, finishes after release. With a local edit and a clashing
    Obsidian push: reply `state: 'conflict'`; a second `POST /pull` → 423. Offline: reply has `pullError`. Fails
    today: 404.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

## Phase 3: web

- [ ] The pill shows "· N incoming" and a tap pulls
  - Test first: `e2e/remote-changes.spec.ts` › "an Obsidian push shows as incoming; one tap brings it in". Open the
    app on `Ideas.md`, `pushFromObsidian(bare, 'Ideas.md', …)`, dispatch `visibilitychange`: `incoming-badge`
    reads "· 1 incoming", has the accessible name "Pull 1 incoming commit from GitHub", and `changes-badge` still
    reads "All committed". Tap it: the badge disappears, the editor shows the new text. Fails today: no badge.
  - Verify: `just e2e e2e/remote-changes.spec.ts` → green; `just check` → green.

- [ ] A clashing pull goes into the conflict flow; the segment hides
  - Test first: `e2e/remote-changes.spec.ts` › "tapping incoming with a clashing local edit ends in conflict". Edit
    `Ideas.md` in the app (saved), `pushFromObsidian` a different `Ideas.md`, dispatch `visibilitychange`, tap
    `incoming-badge`: `changes-badge` reads "Conflict", the conflict banner shows, `incoming-badge` is gone.
  - Verify: `just e2e e2e/remote-changes.spec.ts e2e/git.spec.ts` → green.

- [ ] Offline keeps the count and shows "· offline"
  - Test first: `e2e/remote-changes.spec.ts` › "offline fetch keeps the count". Push from Obsidian, dispatch
    `visibilitychange` (badge "· 1 incoming"), `breakRemote`, dispatch again: `changes-badge` contains "· offline",
    the badge still reads "· 1 incoming"; tap it: a toast "Couldn't reach GitHub", badge unchanged. Restore.
  - Verify: `just e2e e2e/remote-changes.spec.ts` → green.

- [ ] Phone: the Changes panel offers the pull
  - Test first: `e2e/remote-changes.spec.ts` › "phone: Changes tab shows incoming commits · pull". Phone viewport,
    push from Obsidian, dispatch `visibilitychange`, open the Changes tab: `incoming` banner reads "1 incoming
    commit · pull"; tap "pull": the banner disappears. Fails today: no banner.
  - Verify: `just e2e e2e/remote-changes.spec.ts e2e/mobile.spec.ts` → green.

- [ ] The new controls pass the accessibility checks
  - Test first: `e2e/a11y.spec.ts` › add a state with the incoming segment and the banner visible (Obsidian push,
    `visibilitychange`) to the axe scan of the main layout. Fails if the segment lacks a name or has too little
    contrast.
  - Verify: `just e2e e2e/a11y.spec.ts e2e/a11y-keyboard.spec.ts` → green.

- [ ] README mentions incoming changes and the one-tap pull
  - Test first: none, docs only.
  - Verify: `rtk grep -n "incoming" README.md` → a match in the Status feature list.

System docs are updated at `/spec:archive`.
