---
feature: 143-open-page-tool
title: "Plan: current_page tool"
status: proposed
order: 4
created: 2026-10-12
edited: 2026-10-12
---

# Plan: current_page tool

Backend commands run from `apps/backend` (`npm test` = vitest, real opencode container); web from `apps/web`.

- [ ] State module: write, read and remove the open page of a chat on the vaults volume
  - Test first: `apps/backend/test/open-page.test.ts` › "writes <dir>/<chatId>.json, overwrites, removes; a missing dir is created; a bad chat id is refused" — fails today: module missing
  - Verify: `cd apps/backend && npx vitest run test/open-page.test.ts` → green
- [ ] Prompt route takes `openPage` and keeps the state file current
  - Test first: `apps/backend/test/chat.test.ts` › "prompt with openPage writes the state file outside the vault, none removes it, bad path is 400, deleting the chat removes it" — fails today: body field ignored
  - Verify: `cd apps/backend && npx vitest run test/chat.test.ts` → green
- [ ] Tool helper formats the open page and re-checks it against the vault
  - Test first: `apps/backend/test/open-page-tool.test.ts` › "no file → no page open; valid → path, mode, unsaved; deleted file; traversal and dot paths refused; bad session id" — fails today: lib missing
  - Verify: `cd apps/backend && npx vitest run test/open-page-tool.test.ts` → green
- [ ] Ship the tool in the opencode image and allow it for both agents
  - Test first: `apps/backend/test/opencode-tools.test.ts` › "opencode lists current_page as a tool", "current_page is allowed for vault and vault-readonly" — fails today: no tool
  - Verify: `cd apps/backend && npx vitest run test/opencode-tools.test.ts` → green (rebuilds the image)
- [ ] The web app sends the open page with each message
  - Test first: `apps/web/src/store.test.tsx` or `ChatPane` test › "prompt body carries openPage {path, mode, unsaved}; none when no note is open" — fails today: body has no field
  - Verify: `cd apps/web && npx vitest run` and `npx tsc --noEmit` → green
- [ ] Real-model check: the AI reports the open page (`@llm`, inconclusive when the model skips the tool)
  - Test first: `apps/backend/test/chat.llm.test.ts` › "current_page returns the open page" — fails today: no tool
  - Verify: `just test-llm` or the file's own run command → green or inconclusive
- [ ] E2E: open a note, ask the AI which page is open
  - Test first: `e2e/ai-current-page.spec.ts` — fails today: no tool chip
  - Verify: `just dev up` then `just e2e e2e/ai-current-page.spec.ts e2e/ai-open-note.spec.ts` → green
- [ ] Full gate
  - Test first: none — gate only
  - Verify: `just check` → no failures beyond the baseline on main

System docs are updated at `/spec:archive`.
