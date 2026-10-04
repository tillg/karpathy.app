---
feature: remote-changes
title: "Plan: background fetch, incoming count and the user's pull"
status: applying
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

- [x] `Repo.incomingPaths()` lists the files GitHub changed, GitHub's side only
  - Test first: `repo.test.ts` › "incomingPaths lists fetched files on GitHub's side only, one entry per file".
    Clone, Obsidian pushes 3 commits: two to `b.md`, one to `c.md`; `repo.git.run(['fetch', 'origin', 'main'])`:
    `incomingPaths()` is `['b.md', 'c.md']` (3 commits, 2 files). Then commit a local change to `a.md` (no push):
    still `['b.md', 'c.md']`, `unpushedCount()` 1. Fails today: the method doesn't exist.
  - Verify: `npm test -w apps/backend -- repo` → green.

- [x] The list is scoped to the vault root and survives a replaced remote
  - Test first: `repo.test.ts` › "incomingPaths ignores files outside a subfolder vault root". Remote with
    `wiki/a.md` and `outside.md`, `Repo` with root `wiki`; Obsidian pushes a change to `outside.md`, fetch: `[]`;
    pushes a change to `wiki/a.md`, fetch: `['a.md']` (vault-relative). Fails until pathspec and `toVaultPath`.
  - Test first: `repo.test.ts` › "incomingPaths falls back to the tree diff without a merge base". Orphan force-push
    to the bare remote with `x.md` only, fetch: `incomingPaths()` lists every file that differs (no error, not `[]`).
  - Verify: `npm test -w apps/backend -- repo` → green.

- [x] `Repo.fetchUpstream()` moves only `origin/<branch>`
  - Test first: `repo.test.ts` › "fetchUpstream updates the remote ref and nothing else". Local uncommitted edit of
    `a.md` plus one unpushed commit; Obsidian pushes `b.md`. After `fetchUpstream()`: `{ ok: true }`,
    `incomingPaths()` `['b.md']`, `changes()` and `unpushedCount()` unchanged, `b.md` on disk still the old text. Then rename
    the bare repo away: `{ ok: false, error }` with a non-empty error, list still `['b.md']`. Fails today: no such method.
  - Verify: `npm test -w apps/backend -- repo` → green.

## Phase 2: lock and vault

- [x] `VaultLock.tryShared('fetch')` never waits and never shows as busy
  - Test first: `lock.test.ts` › "tryShared grants next to shared holders, refuses while exclusive holds or waits".
    Free lock → granted, `busy` `none`. With a `turn` holder → granted, `busy` `turn`. With an exclusive held → null.
    With a `save` holder and an exclusive queued → null. With a `fetch` holder, `acquireExclusive()` resolves only
    after the fetch releases. Fails today: no `tryShared`, no `fetch` label.
  - Verify: `npm test -w apps/backend -- lock` → green.

- [x] `VaultStatus.incomingCount` and `incomingPaths` are reported
  - Test first: `api.test.ts` › "status reports incoming changes after a fetch, files untouched". `vaultApp()`,
    `obsidianPush({'Other.md': 'remote v2\n'})`, `await t.vaults.fetchRemote(t.id)` → `'fetched'`;
    `GET /status` has `incomingCount: 1`, `incomingPaths: ['Other.md']`; `GET /file?path=Other.md` still `other\n`.
    A fresh vault reports `0` and `[]`. Fails today: no fields, no `fetchRemote`. (Adds the fields and
    `INCOMING_PATHS_MAX` to `packages/shared`.)
  - Verify: `npm test -w apps/backend -- api` → green; `npm run typecheck` → green.

- [x] The path list is capped, the count is exact
  - Test first: `api.test.ts` › "incomingPaths is capped at INCOMING_PATHS_MAX, incomingCount stays exact". Obsidian
    pushes `INCOMING_PATHS_MAX + 5` new files in one commit, `fetchRemote`: `incomingCount` is `MAX + 5`,
    `incomingPaths.length` is `MAX`. Fails until the cap.
  - Verify: `npm test -w apps/backend -- api` → green.

- [x] `fetchRemote` runs during an AI turn and skips git operations
  - Test first: `api.test.ts` › "background fetch runs next to a turn, skips while a git op holds the lock". Hold
    `acquireShared('turn')`, Obsidian pushes, `fetchRemote` → `'fetched'`, status `incomingCount: 1`,
    `busy: 'turn'`. Hold `acquireExclusive()` instead: `fetchRemote` → `'skipped'` without waiting. Two calls at
    once return the same promise. Fails today: no lock rules in `fetchRemote`.
  - Verify: `npm test -w apps/backend -- api` → green.

- [x] A failed fetch sets `pullError` and keeps the count; a good one clears it
  - Test first: `api.test.ts` › "offline background fetch keeps the last count and reports pullError". Obsidian
    pushes, `fetchRemote` → count 1. Rename `remote.bare` away: `fetchRemote` → `'offline'`, status `pullError` set
    and without the token text, `incomingCount` still 1. Rename back: `'fetched'`, `pullError` gone. Fails today:
    fetch errors aren't recorded.
  - Verify: `npm test -w apps/backend -- api` → green.

- [x] The pull on open waits for a running background fetch
  - Test first: `api.test.ts` › "open pulls even while a background fetch runs". Obsidian pushes, start
    `fetchRemote` without awaiting it, `POST /open` → `Other.md` is `remote v2\n` and `incomingCount: 0`. Fails
    today: `tryExclusive` sees the `fetch` holder and skips the pull.
  - Verify: `npm test -w apps/backend -- api` → green; the existing "pull on open … skipped while a shared holder
    runs" stays green.

- [x] The event stream drives the schedule
  - Test first: `api.test.ts`, `describe('event stream')` › "connect fetches, the interval fetches while
    connected, nothing after disconnect". App with `fetchIntervalMs: 200` (new `makeApp` option passed to
    `VaultsEnv`). Obsidian pushes before connecting: the first events include a `status` with `incomingCount: 1`
    within 1 s. Obsidian pushes again: a `status` with `incomingCount: 2` within 1 s. Abort the stream and wait one interval (250 ms, so
    a fetch started before the abort has finished), then Obsidian pushes again, wait 1 s: `GET /status` still
    `incomingCount: 2` (no fetch ran). Connect again, `DELETE` the vault while the stream is open, wait 1 s: no
    unhandled rejection (vitest fails on one). Fails today: nothing fetches.
  - Verify: `npm test -w apps/backend -- api` → green.

- [x] `POST /vaults/:id/pull` runs the existing pull
  - Test first: `api.test.ts` › "pull route: takes incoming changes, waits for a racing turn, refuses in conflict". Obsidian
    pushes, `fetchRemote`, `POST /pull` → 200, `incomingCount: 0`, `Other.md` is `remote v2\n`. With a `turn`
    holder: the request doesn't finish within 200 ms, finishes after release. With a local edit and a clashing
    Obsidian push: reply `state: 'conflict'`; a second `POST /pull` → 423. Offline: reply has `pullError`. Fails
    today: 404.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

## Phase 3: web

- [ ] The incoming controls' state is one pure function
  - Test first: `apps/web/src/lib/incoming.test.ts` › "incomingView: shown when ready with a count, disabled during
    a turn or sync, wording and tab badge". `incomingView(status, pulling)` returns `{ show, disabled, label, title,
    tabMark }`: `ready` + count 2 → shown, enabled, label "Pull 2 incoming changes from GitHub"; count 1 → "change";
    `busy: 'turn'` → disabled, title says the AI is working; `busy: 'sync'` or `pulling` → disabled; `conflict` →
    not shown; count 0 → not shown, `tabMark` false; count 3 → `tabMark` true. The e2e stack can't hold a turn
    without a real LLM, so the turn rule is pinned here. Fails today: no module.
  - Verify: `npm test -w apps/web -- incoming` → green.

- [ ] The pill shows "· N incoming" and a tap pulls, with a toast
  - Test first: `e2e/remote-changes.spec.ts` › "an Obsidian push shows as incoming; one tap brings it in". Open the
    app on `Other.md`, `pushFromObsidian(bare, 'Ideas.md', …)` with two commits to `Ideas.md`, dispatch
    `visibilitychange`: `incoming-badge` reads "· 1 incoming" (files, not commits), has the accessible name "Pull 1
    incoming change from GitHub", and `changes-badge` still reads "All committed". Tap it: toast "Pulled 1 change
    from GitHub", the badge disappears; open `Ideas.md`: new text. Fails today: no badge.
  - Verify: `just e2e e2e/remote-changes.spec.ts` → green; `just check` → green.

- [ ] The open note warns when it is incoming
  - Test first: `e2e/remote-changes.spec.ts` › "the open note shows 'Changed on GitHub · Pull' and stays editable".
    Open `Ideas.md`, push a change to `Ideas.md` from Obsidian, dispatch `visibilitychange`: `incoming-note` is
    visible, the editor still accepts typing. Push to another file only (fresh vault): no `incoming-note`. Tap the
    bar's "Pull" (clean editor): the bar disappears, the editor shows the new text. Fails today: no bar.
  - Verify: `just e2e e2e/remote-changes.spec.ts` → green.

- [ ] The Changes panel lists the incoming files
  - Test first: `e2e/remote-changes.spec.ts` › "Changes panel lists incoming files". Push changes to `Ideas.md` and
    `Other.md` from Obsidian, dispatch `visibilitychange`, open Changes: `incoming` reads "2 incoming changes ·
    pull", `incoming-list` holds both names, no diff opens on click. The "…and N more" row is covered by the
    backend cap test plus `incoming.test.ts` (`moreCount` = count − paths length). Fails today: no list.
  - Verify: `just e2e e2e/remote-changes.spec.ts` → green.

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

- [ ] Phone: the tab badge shows "↓", the Changes panel offers the pull
  - Test first: `e2e/remote-changes.spec.ts` › "phone: tab badge ↓ and Changes panel pull". Phone viewport, clean
    vault, push from Obsidian, dispatch `visibilitychange`: `changes-badge-tab` reads "↓". Open the Changes tab:
    `incoming` banner reads "1 incoming change · pull"; tap "pull": the banner and the "↓" disappear. Fails today: no
    badge mark, no banner.
  - Verify: `just e2e e2e/remote-changes.spec.ts e2e/mobile.spec.ts` → green.

- [ ] The new controls pass the accessibility checks
  - Test first: `e2e/a11y.spec.ts` › add a state with the incoming segment, the open-note bar, the Changes banner and
    list visible (Obsidian push to the open note, `visibilitychange`) to the axe scan of the main layout. Fails if a
    control lacks a name or has too little contrast.
  - Verify: `just e2e e2e/a11y.spec.ts e2e/a11y-keyboard.spec.ts` → green.

- [ ] README mentions incoming changes and the one-tap pull
  - Test first: none, docs only.
  - Verify: `rtk grep -n "incoming" README.md` → a match in the Status feature list.

System docs are updated at `/spec:archive`.
