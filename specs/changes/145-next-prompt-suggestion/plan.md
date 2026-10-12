---
feature: 145-next-prompt-suggestion
title: "Plan: next-prompt suggestion"
status: applying
order: 4
created: 2026-10-13
edited: 2026-10-13
---

# Plan: next-prompt suggestion

E2E steps run against this checkout's stack (`just dev up` first, `just dev down` when done).

- [x] Tool logic: `cleanSuggestion`
  - Test first: `apps/backend/test/suggest-next-tool.test.ts` › trims and collapses whitespace, refuses empty and > 160 chars — fails today: no module
  - Verify: `npx vitest run apps/backend/test/suggest-next-tool.test.ts` → green
- [x] Tool baked into the image and allowed for the agents
  - Test first: `apps/backend/test/opencode-tools.test.ts` › "opencode lists suggest_next as a tool", "suggest_next is allowed for vault and vault-readonly" — fails today: no tool
  - Verify: `npx vitest run apps/backend/test/opencode-tools.test.ts -t suggest_next` → green (real container)
- [x] Harness mapping sets `ToolCall.suggestion`
  - Test first: `apps/backend/test/harness-map.test.ts` › "suggest_next maps to suggestion, not writes/opens" on a synthetic tool part — fails today: field missing
  - Verify: `npx vitest run apps/backend/test/harness-map.test.ts` → green
- [ ] `nextSuggestion(messages, turn)` picks the live suggestion
  - Test first: `apps/web/src/lib/chat.test.ts` › latest call wins; none while running/queued; none after a user message; ignores error and empty — fails today: no function
  - Verify: `npx vitest run apps/web/src/lib/chat.test.ts` → green
- [x] Composer ghost text, Tab and tap accept, hidden chip
  - Test first: `apps/web/src/components/Suggestion.test.tsx` › ghost shows while text empty, disappears on typing; Tab accepts (not sent); tap accepts; `Parts` renders no chip for `suggest_next` — fails today: no component
  - Verify: `npx vitest run apps/web/src/components/Suggestion.test.tsx` → green
- [x] Standing instruction: tool description tells the model when to call it
  - Test first: `apps/backend/test/suggest-next-tool.test.ts` › description says "at most once", "last" — fails today: no tool
  - Verify: same test → green
- [ ] E2E with the real model and the phone viewport
  - Test first: `e2e/ai-suggest-next.spec.ts` › `@llm` ghost text after a reply, Tab accepts without sending, typing clears it, tap on phone — fails today: nothing renders
  - Verify: `npx playwright test e2e/ai-suggest-next.spec.ts` against this checkout's stack → green; screenshots in `tmp/`

System docs are updated at `/spec:archive`.
