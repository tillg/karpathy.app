---
feature: 145-next-prompt-suggestion
title: "Architecture: next-prompt suggestion"
status: proposed
order: 3
created: 2026-10-13
edited: 2026-10-13
---

# Architecture: next-prompt suggestion

opencode stays the agentic loop; the suggestion is one more baked-in custom tool, wired like `open_note`.

```mermaid
sequenceDiagram
  participant O as opencode (suggest_next)
  participant H as backend harness/map.ts
  participant W as web Conversation
  O-->>H: tool part completed (input.prompt)
  H-->>W: ChatPart tool, call.suggestion
  W->>W: Parts hides the chip; nextSuggestion(messages, turn)
  W->>W: composer empty and idle: ghost text + "Tap to use"
  W->>W: Tab / tap: setText(suggestion)
```

## Tool (`deploy/opencode/tools/suggest_next.ts`, logic in `deploy/opencode/lib/suggestion.ts`)

- Args `{ prompt: string }`. `cleanSuggestion` collapses whitespace, refuses an empty prompt and one over 160
  characters ("too long, shorten it") so the model can retry; returns `suggested: <prompt>`. It touches no file and
  no network.
- The description carries the standing instruction: call it **at most once per turn, as the very last action, after
  the answer is written**, with a concise next step the user could send, written as the user (imperative or question)
  and in the user's language; skip it when no sensible next step exists, after errors, and in command turns it still
  applies. This is the only place the instruction lives (no AGENTS.md injection: opencode has no app-level system
  prompt hook that is provider-agnostic and small; the tool description is part of every request).
- Baked like `open_note`: Dockerfile bake poll also waits for the tool id; `opencode.json` allows it for `vault`
  and `vault-readonly`. `commit-message` keeps `"*": "deny"`. It is not in `WRITE_TOOLS`.

## Harness mapping (`apps/backend/src/harness/map.ts`, `packages/shared`)

`ToolCall.suggestion?: string` is set for `suggest_next` from `state.input.prompt`. No other field changes
(`writes: false`, `opens: false`, no path). One added line in `mapToolPart`; nothing in the shared tool sets.

## Web (`apps/web/src/lib/chat.ts`, `ChatPane.tsx`, `styles.css`)

- `nextSuggestion(messages, turn)` (pure): `null` unless the turn is `idle`; scans the messages after the last user
  message from the end and returns the `suggestion` of the latest `completed` call with a non-empty one. Derived
  from history, so it survives a reload and another device, and a new turn (`queued`/`running`) or a new user
  message clears it with no extra state.
- `Parts` skips `suggest_next` calls entirely (any status): the ghost text is its presentation, and a failed call
  (too long) needs no chip.
- Composer: when `suggestion && text === '' && !busy` the textarea shows an overlay ghost (a `pointer-events: none`
  single line with ellipsis, positioned over the textarea, `aria-hidden`) and a `Use` button (`data-testid=
  "chat-suggestion"`) above the input row reads "Tab to use" on `(hover: hover)` devices and "Tap to use" otherwise;
  its accessible name is "Use suggested prompt: <text>". Tab in `onComposerKey` (no palette open, no shift) calls
  `accept`; the button's `onPointerDown` does the same with `preventDefault` so the composer keeps focus.
  `accept` = `setText(suggestion)`, focus, cursor at the end, resize the textarea. Escape is not needed: typing
  removes it.
- Placeholder text stays for the empty-chat case; the ghost overlay replaces it visually while a suggestion is live.

## Decisions

- **Tool, not a second LLM call.** A second call doubles cost and latency and needs a provider path outside
  opencode; the tool rides the turn that already has the context.
- **Derived, not stored.** The history already persists tool parts; persistence across reloads is free. Cost: if
  the user clears the composer again (after accepting), the ghost reappears. Acceptable, and arguably useful.
- **Chip hidden.** A chip would duplicate the ghost text.
- **Tap affordance as a button.** Soft keyboards have no Tab; a tap on the ghost text itself would collide with
  focusing the composer.

## Security

The tool reads and writes nothing; its text only ever reaches the composer as plain text (React text node, never
HTML), and nothing is sent without the user pressing Enter. Not in `WRITE_TOOLS`, so it never makes an AI stamp.
