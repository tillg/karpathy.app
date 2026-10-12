---
feature: 146-image-model
title: "Plan: image model"
status: applying
order: 4
created: 2026-10-13
edited: 2026-10-13
---

# Plan: image model

E2E and `@llm` steps run against this checkout's stack or the test containers (`just dev up` first, `just dev down`
when done; the native Ollama must be up: `just ollama status`).

- [x] Schema: `vision_model` required, endpoint must be OpenAI-compatible; every environment sets it
  - Test first: `packages/settings/test/schema.test.ts` › "vision_model is required", "anthropic gateway refused for vision"; `repo-settings.test.ts` › hetzner `openrouter/mistralai/mistral-small-2603` with the ZDR provider routing, dev/local/prodtest/test `ollama/qwen3-vl:2b` — fails today: optional, not set
  - Verify: `npx vitest run packages/settings` → green; `just settings check`
- [ ] Render the vision endpoint into `opencode.env`
  - Test first: `packages/settings/test/render.test.ts` › hetzner has `VISION_BASE_URL=https://openrouter.ai/api/v1`, `VISION_MODEL`, `VISION_API_KEY`, `VISION_REQUEST_OPTIONS` with ZDR `provider`; dev has no key, base URL of the relay — fails today: keys missing
  - Verify: `npx vitest run packages/settings`; `just settings show hetzner` shows the vision model, no secret values
- [ ] Tool logic: `resolveImage`, `buildRequest`, `describeImage` errors
  - Test first: `apps/backend/test/look-at-image-tool.test.ts` › accepts png/jpg, refuses outside/dot/missing/pdf/svg/oversized; request has the data URL, question and options; "not configured" error; no key in errors — fails today: no module
  - Verify: `npx vitest run apps/backend/test/look-at-image-tool.test.ts` → green
- [ ] Tool baked into the image, allowed for `vault` and `vault-readonly`, vision env reaches it
  - Test first: `apps/backend/test/opencode-tools.test.ts` › "opencode lists look_at_image as a tool", "look_at_image is allowed for vault and vault-readonly, not commit-message" — fails today: no tool
  - Verify: `npx vitest run apps/backend/test/opencode-tools.test.ts -t look_at_image` → green (real container)
- [ ] The real vision model describes a test image through the tool
  - Test first: `apps/backend/test/look-at-image.llm.test.ts` › `@llm` a chat turn asking about a generated all-red PNG calls `look_at_image` and the answer/tool output names red — fails today: no tool
  - Verify: `npx vitest run apps/backend/test/look-at-image.llm.test.ts` → green (qwen3-vl:2b via the Mac's Ollama)
- [ ] Chip: images never warn, PDFs still do
  - Test first: `apps/web/src/components/AttachChip.test.tsx` › text-only model + image: no warning; text-only + PDF: warning; `e2e/attach.spec.ts` drops the image warning assertion — fails today: warns
  - Verify: `npx vitest run apps/web/src/components/AttachChip.test.tsx` → green
- [ ] E2E: attached image, text-only chat model, AI answers from the image
  - Test first: `e2e/ai-image.spec.ts` › `@llm` attach a red-square PNG, ask what colour it is, a `look_at_image` chip shows — fails today: AI can't see it
  - Verify: `npx playwright test e2e/ai-image.spec.ts e2e/ai-open-note.spec.ts` against this checkout's stack → green

System docs (`specs/system/`) and README are updated in the final commit; this change is not archived here.
