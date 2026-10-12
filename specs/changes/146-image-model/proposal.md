---
feature: 146-image-model
title: "Proposal: image model"
status: applying
order: 1
created: 2026-10-13
edited: 2026-10-13
---

# Proposal: image model

**Issue:** #146

## What

The AI can interpret images. A separate **vision model** looks at an image of the vault (or one attached to a chat
message) and tells the chat model what it shows, through a baked-in opencode tool `look_at_image`. The chat model
stays as it is (production: `openrouter/z-ai/glm-5.3`, text-only, deliberately routed through ZDR providers).

## Why

Photos, screenshots, scanned lists and diagrams in a vault are invisible to the production model today: an attached
image ends as "ERROR: Cannot read …" and the chip warns "can't see images". Swapping the chat model for an
image-capable one would give up the ZDR routing that was chosen on purpose.

## How, in short

- `ai.vision_model` (exists, used only by the `test` environment) becomes a real setting of every environment.
  Default (and production): `openrouter/mistralai/mistral-small-2603`: takes images and tools, and has a
  `mistral/zdr` endpoint, configured under `gateways.openrouter.models` with the same ZDR routing as glm-5.3. Dev,
  local, prodtest and test: `ollama/qwen3-vl:2b` (the native Ollama on the Mac).
- The settings package renders the vision model's endpoint, key and request options into `opencode.env`.
- `look_at_image({ path, question? })` reads the image from the vault (same checks as `open_note`, plus image type
  and a size cap), asks the vision model through the gateway's OpenAI-compatible `/chat/completions` through the egress
  proxy, and returns its text. Keys stay in the opencode container; the AI never sees them.
- The attachment chip no longer says a text-only model can't see an image (PDFs still warn: the tool reads images only).

## Scope

- In: setting for every environment, ZDR routing for the production vision model, rendering, tool, chip text, tests,
  docs.
- Out: PDFs (the tool refuses them), video, a per-vault or Admin override of the vision model, a second gateway for
  vision (the vision model uses the chat model's gateway), and **local recognition on macOS** (Vision framework,
  OCR): a possible later provider behind the same tool; noted here only, not built.

## Expected outcome

With the text-only production model, "what is in `Photos/receipt.jpg`?" or an attached photo is answered from the
vision model's description, shown as a `look_at_image` chip. In dev the same works with `qwen3-vl:2b`.
