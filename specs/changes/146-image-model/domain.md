---
feature: 146-image-model
title: "Domain: image model"
status: proposed
order: 2
created: 2026-10-13
edited: 2026-10-13
---

# Domain: image model

| Term | Meaning |
|---|---|
| Vision model | The model that looks at images for the chat model (`ai.vision_model`). Distinct from the chat model (`ai.model`); same gateway. Not selectable in the app. |
| `look_at_image` | Baked-in opencode tool: path (and an optional question) in, the vision model's text out. |

No new entity. The vision model is a deployment setting like the default chat model.
