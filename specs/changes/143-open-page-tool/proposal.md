---
feature: 143-open-page-tool
title: "Proposal: tell the AI which page is open"
status: proposed
order: 1
created: 2026-10-12
edited: 2026-10-12
---

# Proposal: tell the AI which page is open

**Issue:** [#143](https://github.com/tillg/karpathy.app/issues/143)

## Why

The AI can read, write and open notes, but not see what the user is looking at. "Summarize this note" or "fix the
typos on this page" forces the user to name the file. The chat should know the open page.

## What

- The web app sends the open file (vault path, Read or Write mode, unsaved edits yes/no; nothing when no file is
  open) with every chat message.
- A new baked-in tool `current_page` returns it: "The user has `Lists/Reading.md` open (Write mode)". The model then
  uses `read` on that path. Allowed for `vault` and `vault-readonly`; reads nothing from the vault itself.
- The tool description tells the model to call it when the user says "this note", "this page", "here".

## Out of scope

Cursor position / selection, the other panes (graph, search), several open files, injecting the page into every
prompt (a tool costs no context on turns that don't need it, and shows up as a chip), a client-side tool.

## Success

On a turn sent while `notes/Todo.md` is open, the AI can learn `notes/Todo.md` through `current_page`; with no file
open it learns that; the value never leaves the vault (path traversal refused) and never appears as a file in the
vault's git clone.
