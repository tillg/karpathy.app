---
feature: note-sort-options
title: "Plan: sort and filter the file tree"
status: applied
order: 4
created: 2026-10-05
edited: 2026-10-05
---

# Plan: sort and filter the file tree

Before starting: commit (or otherwise settle) the uncommitted `chat-commands-research` edits in
`files.ts`, `vaults.ts` and `packages/shared/src/index.ts`, so this change's diffs stay separate.

## Phase 1 — Backend: dates in the file listing

- [x] Add optional `modified`, `ai`, `human` (epoch ms) to `FileEntry` in `packages/shared`
  - Test first: none — type-only change, no runtime surface
  - Verify: `npm run typecheck` (all workspaces) → exit 0
- [x] Update the exact `/files` listing expectations in `api.test.ts` (:104, :166, :194, :325, :355; `github.github.test.ts:44` already compares paths only) to compare `{path, type}` only — a deliberate contract change (the listing now carries dates); confirm with the user before applying, since it edits existing tests
  - Test first: existing tests keep passing before and after (they still compare paths and types, via a `.map(({path, type}) => ({path, type}))`)
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green; `npm run test:github` → green (needs the GitHub token)
- [x] Committed files get `modified` = time of the last commit that changed them
  - Test first: `api.test.ts` › "files: modified is the last commit time, not the clone's mtime" — commit `old.md` with author date 2020, `b.md` now; after a fresh clone both have the same mtime, but `/files` must give `a.md` the 2020 time. Fails today: no `modified` field
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Uncommitted files get `modified` = their mtime
  - Test first: `api.test.ts` › "files: an uncommitted file's modified is its mtime" — PUT `a.md`, set its mtime with `utimes` to a known time, expect that time. Fails: listing uses commit time only
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Git history gives `human` = last commit without the AI trailer
  - Test first: `api.test.ts` › "files: human from commits without the AI trailer only" — remote commit to `h.md` (no trailer) and a commit with `AI_TRAILER` to `m.md`, pull; expect `human` on `h.md`, none on `m.md`. Fails: no `human` field
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Cache the history pass per HEAD; recompute after commit and pull
  - Test first: `api.test.ts` › "files: dates follow a new commit" — list, commit a change to `a.md` with a later `GIT_COMMITTER_DATE`, list again; expect the new time. Passes only if the cache key is HEAD (a naive memo fails it)
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Vault root other than the repo root: history paths map to vault paths, outside paths dropped
  - Test first: `api.test.ts` › "files: dates with a vault root" — vault with `root: 'wiki'`, commit `wiki/a.md` and `other/b.md`; expect `modified` on `a.md` and no error for `b.md`. Fails: paths not mapped
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green

## Phase 2 — Backend: edit stamps

- [x] Persist `editStamps` in the config store (default `{}`), survive restart
  - Test first: `api.test.ts` › "edit stamps survive a restart and a commit" — `markAiTouched` on `x.md`, restart (`makeApp` with same dirs, as in the AI-touched test), commit; `/files` still gives `ai` for `x.md`. Fails: no `stampAi`
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] `markAiTouched` (the chat `file-edited` entry point) stamps the AI date
  - Test first: `api.test.ts` › "file-edited stamps ai, not human" — drive the same entry point `chat.ts` uses for a `file-edited` event; `/files` gives `ai` ≈ now and no `human` on an uncommitted untracked file. Fails: the event only feeds `aiTouched`
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Save, create and upload stamp the human date
  - Test first: `api.test.ts` › "save and upload stamp human" — PUT `n.md`, upload an image; both have `human` ≈ now, no `ai`. Fails: nothing stamps
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Discard drops only stamps newer than the last commit; move into own folder carries them; vault removal deletes them
  - Test first: `api.test.ts` › "edit stamps: discard, move, removal" — untracked `u.md` stamped ai, discard → no `ai`; `c.md` stamped ai, committed, then saved by the user and discarded → keeps the old `ai`, loses the new `human`; stamp `foo.md`, upload from the editor so it moves to `foo/foo.md` → `ai` on the new path; remove the vault → `editStamps[id]` gone. Fails: lifecycle not wired
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] Listing drops stamps of paths that no longer exist
  - Test first: `api.test.ts` › "stamps of deleted files are dropped" — stamp `gone.md`, delete it on disk, list, recreate it, list; expect no `ai`. Fails: the stale stamp comes back
  - Verify: `npm test -w apps/backend -- test/api.test.ts` → all green
- [x] A real chat turn yields an `ai` date
  - Test first: `chat.llm.test.ts` › "a turn that writes a file stamps ai" — prompt the AI to write `ai-note.md`; after the turn `/files` has `ai` for it. Fails until the wiring above exists; run against real opencode
  - Verify: `npm run test:llm -- chat.llm` → green (inconclusive if the CI model is missing, as for the other LLM tests)

## Phase 3 — Web: sort and filter logic

- [x] `buildTree(entries)` at the defaults (name, asc, any) stays identical to today
  - Test first: existing `tree.test.ts` › "nests entries with folders first" passes before and after, plus a new case: explicit defaults give the same tree as no arguments
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] Sort by name Z → A
  - Test first: `tree.test.ts` › "name desc reverses within folders, folders still first". Fails: `buildTree` ignores direction
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] Sort by Last changed in both directions, ties by name A → Z, undated last in both
  - Test first: `tree.test.ts` › "changed sorts by date both ways, undated last" — files with `modified` 3/1/none and a tie at 3; desc → 3 (tie by name), 1, undated; asc → 1, 3 (tie by name), undated. Fails: dates ignored
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] Folders first, ranked by their newest descendant
  - Test first: `tree.test.ts` › "ranks folders by newest descendant" — `b/deep/x.md` (9) above `a/y.md` (5) under changed desc, below it under asc; `a` first under name. Fails: folders alphabetical
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] Filter keeps matching files and the folders on their way; empty folders vanish
  - Test first: `tree.test.ts` › "filter ai keeps only AI files and their folders" — entries with and without `ai`, plus a `type: 'dir'` folder with no matching file; under `ai` only matching files, their ancestors, no empty folder; `any` keeps all. Fails: no filter
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] The filter picks the date Last changed uses
  - Test first: `tree.test.ts` › "human + changed sorts by the human date" — `p.md` {modified 9, human 2}, `q.md` {modified 5, human 4}; under human + changed desc `q` comes first, under any + changed desc `p`. Fails: always uses `modified`
  - Verify: `npm test -w apps/web -- tree` → all green
- [x] Sort and filter preferences load/save (`karpathy.treeSort`, `karpathy.treeFilter`), broken values → defaults, storage errors swallowed
  - Test first: `tree.test.ts` › "view preference round-trips and falls back" — save {changed, desc} + `ai`, load both; stored `bogus` / bad JSON → defaults; throwing storage → defaults. Fails: functions don't exist
  - Verify: `npm test -w apps/web -- tree` → all green

## Phase 4 — Web: controls

- [x] Sort menu: criterion + direction, labels follow the criterion, picking a criterion sets its natural direction, tint when not default, remembered across reload
  - Test first: `e2e/tree-sort.spec.ts` › "sort menu sets criterion and direction" — vault with `a.md` committed long ago and `z.md` saved now. Name A → Z: `a` first. Pick Last changed: direction shows "Newest first" checked, `z` first. Pick Oldest first: `a` first. Back to Name: labels read "A → Z / Z → A". Reload keeps the choice. Button has `.on` when not default. Fails: no `tree-sort` button
  - Verify: `just e2e e2e/tree-sort.spec.ts` → green (dev stack running)
- [x] Filter menu + chip: AI shows only AI files; chip names the filter; ✕ resets; empty-state text; remembered across reload
  - Test first: `e2e/tree-sort.spec.ts` › "filter by AI shows only AI files". On a fresh vault, pick AI: the empty text shows. Then run a real model turn, as `ai-open-note.spec.ts` does (dev: local Ollama, long timeouts), asking the AI to write `ai-only.md`; the test waits for the "changed" chip. After a reload (live updates are the next step), `ai-only.md` shows but no seed note does, and the chip "Changed by AI" is visible. ✕ brings all notes back. Fails today: there is no `tree-filter` button.
  - Verify: `just e2e e2e/tree-sort.spec.ts` → green
- [x] Live update: with dates in use, a modification refetches the listing (debounced), the end of a turn refetches once, and switching into a date view refetches
  - Test first: `e2e/tree-sort.spec.ts` › "a save elsewhere moves the note up" — modify `Home.md` under Name, switch to Last changed: `Home` is first (fresh dates); then write `Ideas.md` through the API (another tab): `Ideas` moves to the top without reload. Fails: modifications don't refetch `/files`
  - Verify: `just e2e e2e/tree-sort.spec.ts` → green
- [x] Accessibility of both menus (roles, `aria-checked`, `aria-expanded`, Escape closes, focus returns to the button)
  - Test first: `e2e/a11y.spec.ts` › add both open menus and the chip to the axe scan; assert `menuitemradio` + `aria-checked`. The menus already existed (steps 21–22), so the test was checked by mutation: without `aria-checked` it fails
  - Verify: `just e2e e2e/a11y.spec.ts` → green
- [x] README: one line on sort and filter
  - Test first: none — docs only
  - Verify: `grep -n "Sort" README.md` → matches the new line

## Phase 5 — Full check

- [x] Full suite and the browser check
  - Test first: none — final verification
  - Verify: `just check` → exit 0; `just e2e` → all green; screenshots of the tree (Name, Last changed both ways, AI filter with chip, both menus open) at phone width and 1× scale saved to `tmp/`, checking the last folder of the tree too

System docs are updated at `/spec:archive`.
