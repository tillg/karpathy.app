---
feature: 146-image-model
title: "Architecture: image model"
status: applying
order: 3
created: 2026-10-13
edited: 2026-10-13
---

# Architecture: image model

opencode stays the loop; the vision model is reached by one more baked-in tool, wired like `save_url` (outbound HTTP
through the egress proxy).

```mermaid
sequenceDiagram
  participant C as chat model (opencode)
  participant T as look_at_image (opencode container)
  participant E as egress proxy
  participant G as gateway (OpenRouter / Ollama)
  C->>T: path, question
  T->>T: resolve path in the vault, type, size
  T->>E: POST /chat/completions (image as data URL, key, provider options)
  E->>G: (public hosts only; Ollama relay is NO_PROXY)
  G-->>T: description
  T-->>C: text
```

## Settings (`deploy/settings/`, `packages/settings`)

- `ai.vision_model` becomes required in the schema. `settings.yaml`: `openrouter/mistralai/mistral-small-2603`;
  `dev`, `local`, `prodtest`, `test`: `ollama/qwen3-vl:2b` (`dev`/`local`/`prodtest` already override `ai` as a whole
  object key by key, so they add `vision_model`; `test` keeps it).
- `gateways.openrouter.models["mistralai/mistral-small-2603"].options.provider` =
  `{ order: [mistral/zdr, mistral], only: [mistral/zdr, mistral], zdr: true, data_collection: deny }`.
- Cross-field rules: the vision model must belong to `ai.gateway` (as today) and that gateway must speak the OpenAI
  chat API: kind `openrouter`, `openai` or `openai-compatible` (not `anthropic`).
- `renderOpencodeEnv` adds `VISION_BASE_URL` (gateway `base_url`, or the known endpoint of openrouter/openai),
  `VISION_MODEL` (id without the gateway prefix), `VISION_API_KEY` (the gateway's key, only when it has one) and
  `VISION_REQUEST_OPTIONS` (the model's `options` from `gateways.<g>.models`, JSON, merged into the request body: this
  carries the ZDR `provider` object). Compose and Ansible need no change: `opencode.env` is already loaded and the
  Ansible role renders it from the same package.
- The backend does not need the vision model (`settings.json` unchanged).

## Tool (`deploy/opencode/tools/look_at_image.ts`, logic in `deploy/opencode/lib/look-at-image.ts`)

- Args `{ path, question? }`. `resolveImage(dir, path)` reuses `resolveNote` (inside the vault, no dot segments,
  exists, no symlink out), then allows png, jpg, jpeg, gif, webp (no SVG: it is not an image to a model; no HEIC) and
  caps the size at 10 MB. Errors are tool errors the model can read.
- `buildRequest` makes `{ model, messages: [{ role: user, content: [{type: text}, {type: image_url, data URL}] }],
  max_tokens, stream: false, ...VISION_REQUEST_OPTIONS }`. The default question asks for a thorough description
  including any text in the image (transcribed).
- `describeImage` POSTs it with Bun's `fetch(…, { proxy })` exactly like `save_url` (proxy from `HTTPS_PROXY`/`HTTP_PROXY`;
  Bun's own `NO_PROXY` keeps the dev Ollama relay direct), 120 s timeout, `Authorization: Bearer VISION_API_KEY` when set. It
  throws without the vision env (`image recognition is not configured`) and on HTTP errors (status and a short body
  excerpt; the key never appears in any message). The answer is the first choice's text, cut at 8000 characters.
- The description tells the chat model: use it for any image in the vault or attached to the message (an attached file
  appears in the prompt as a path under `Sources/upload-…/`), also when you cannot see images yourself, and pass a
  specific `question` for details.
- Read-only: allowed for `vault` and `vault-readonly`; baked like the others (Dockerfile poll waits for the id).
  Not in `WRITE_TOOLS`.
- The chat model with image input still reads images directly when opencode inlines an attachment; the tool stays
  available for it too (a second opinion costs nothing, and the model decides). No per-model switch.

## Harness mapping and web

- `look_at_image` is an ordinary tool chip (path shown as for `read`); no mapping change beyond what generic tools get.
- `ChipView`: `blind` only for PDFs (`!input.pdf`); images never warn. The PDF text is unchanged.

## Security

Keys stay in the opencode container env (as `OPENROUTER_API_KEY` already is). The request goes only to the configured
gateway's URL through the egress proxy; the tool takes no URL argument. The image path is checked as for `open_note`.
Images leave the server only to the vision model's gateway, under the same ZDR routing as the chat model.
