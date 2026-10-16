---
feature: remove-ollama
title: "Domain: remove Ollama"
status: applying
order: 2
created: 2026-10-15
edited: 2026-10-16
---

# Domain: remove Ollama

## New terms

| Term | Meaning | In code (planned) |
|---|---|---|
| **Test model** | The model the tests run on: always OpenRouter, everywhere (backend `@llm` locally and in CI, e2e, prodtest) — the production models, inherited by `deploy/settings/test.yaml`; `LLM_TEST_MODEL` picks another OpenRouter model. No key → the `@llm` tests stop with a message before they start. | `testModels()`, `pickTestModels()` |
| **Dead model** | A declared model the provider doesn't have: every turn on it fails at once with a non-retryable error, so the default tier exercises the whole turn lifecycle without an LLM. Now on a test-only provider `dead` that points at opencode's own port (401): offline, not a model source. | `DEAD_MODEL`, `DEAD_MODEL_2` |

## Changed terms

| Term | Before | After |
|---|---|---|
| **Gateway** (settings) | `openrouter`, `ollama`, `omlx` | `openrouter` (the `openai-compatible` kind stays available) |
| **Test settings** (`test.yaml`) | Ollama models | Empty: the production models on OpenRouter |
| **Dev / prodtest settings** | omlx models | No `ai` block: the production models on OpenRouter |

## Removed terms

| Term | Was |
|---|---|
| **Ollama relay** (system term) | The per-stack Caddy that reached a model server on the Mac; renamed *model relay* in the first apply round, then removed with omlx. |
| **`relay_upstream`** (gateway setting) | Where that relay found the model server. |

## Rules

- Every model comes from OpenRouter: production, all tests, dev and prodtest. There is no local model server. (The
  test-only `dead` provider answers nothing; it isn't a model source.)
- The word "Ollama" appears only in history (`specs/research/**`, `DECISIONS.md`); a test enforces it.
- No silent test model: without an OpenRouter key the `@llm` tests fail with what to do, never with empty replies or
  an auth error mid-turn.
