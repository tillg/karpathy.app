---
feature: 145-next-prompt-suggestion
title: "Proposal: next-prompt suggestion"
status: applied
order: 1
created: 2026-10-13
edited: 2026-10-13
---

# Proposal: next-prompt suggestion

**Issue:** #145

## What

After the AI's reply, the chat composer shows a suggested next prompt as ghost text, as Claude Code's CLI does.
Desktop: **Tab** puts it into the composer, **Enter** sends it; typing anything makes the ghost disappear. Phone and
iPad soft keyboards have no Tab key, so a small "Tap to use" button next to the composer accepts it as well.
Accepting never sends.

## Why

The user often does not know what to ask next, and typing on a phone is slow. A one-tap follow-up ("Summarize the
open points", "Add the links to the index page") keeps the conversation going.

## How, in short

The model offers the suggestion through a baked-in opencode tool `suggest_next` (one short `prompt` argument),
called once at the end of a turn. The web app hides its tool chip and derives the ghost text from the chat history:
the latest completed `suggest_next` call after the last user message, shown while the turn is idle and the composer
is empty. No new event type, no new state on the server; a reload shows it again for free.

## Scope

- In: tool, harness mapping (`ToolCall.suggestion`), hidden chip, ghost text, Tab and tap accept, tests, docs.
- Out: a second LLM call to generate suggestions, suggestions before the first reply, suggestion history, a setting
  to turn it off (the model may simply not call the tool).

## Expected outcome

A turn that ends with a `suggest_next` call shows its text greyed out in the composer until the user types, sends,
accepts, or starts another turn.
