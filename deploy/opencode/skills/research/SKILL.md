---
name: research
description: Research a topic on the web and write cited wiki pages. Type /research and the topic.
---

# Research

You research a topic for the user in two steps: first a short **plan turn** that writes a plan note and
stops, then **run turns** that search the web, save sources and write wiki pages. This skill ships with
the app and has no files of its own: everything you need is on this page.

## Conventions first

Follow the vault's own instructions (`AGENTS.md`, `CLAUDE.md`, an ingest skill) for where sources and
pages go and what their frontmatter looks like. Use the rest of this skill where they say nothing.
One rule always holds, whatever the vault's rules say: a source file holds a summary with short quotes,
never the whole page.

## Which turn is this?

- **No topic** after `/research`: ask the user for one and stop.
- **Resume:** the text after `/research` names an existing plan note (its path, or a topic that matches a
  note in `Research/`). Skip the plan: this turn is a run turn on that note's open sub-questions. This works
  in any chat, days later.
- **Plan turn:** otherwise, the turn that starts with `/research <topic>`.
- **Run turn:** the user's reply to a plan ("go", "continue", or edits of the note). Read the plan note again
  first: the user may have changed it.

## Plan turn

1. Read the wiki's index (e.g. `Wiki/index.md`) and the pages on the topic.
2. If you have the web tools (`websearch`, `webfetch`), scout a little: **at most 3 searches and 2 fetches**.
   Save nothing to `Sources/` in this turn. If you don't have them, say at the start of your reply that
   **Web access** must be turned on in **Settings** before the run.
3. Write the plan note `Research/<YYYY-MM-DD>-<slug>.md` (folder per the vault's rules) with:
   - the topic;
   - 3–6 sub-questions as a checklist (`- [ ] …`);
   - what the wiki already covers, with links to those pages;
   - the budget: at most 8 sources per run turn.
4. End your reply with: "Edit the note if you like, then reply **go**." Write nothing else in this turn.

If you can't write files (the vault is in conflict and editing is denied), put the plan into your reply
instead.

## Run turn

1. Read the plan note again.
2. **No web tools:** answer and tick off the sub-questions the wiki already covers, tell the user to turn on
   **Web access** in **Settings** for the rest, and stop.
3. For each open sub-question: at most 2 web searches. Pick useful results. Before fetching a URL, search
   `Sources/` for it and skip it if it is there already. Fetch it, then save a source file (below). **At most
   8 new sources per run turn.**
4. Create or update wiki pages that answer the questions and cite their source files. Update the vault's
   index and log pages if it has them.
5. Tick off answered sub-questions in the plan note (`- [x]`) and link the pages that answer them.

## Source file

`Sources/<YYYY-MM-DD>-<slug>.md` in the vault's existing `Sources/` folder (any case), with frontmatter:

```yaml
---
type: source
url: <the page's URL>
title: <the page's title>
fetched: <YYYY-MM-DD>
---
```

Body: a summary in the vault's language plus short quotes. Never the whole page, even when the vault's
rules ask for full sources (they decide folder, file name and frontmatter only).

## Citations

Every claim from the web names its source file: in the page's frontmatter `sources:` and as an inline
`[[Sources/…]]` link.

## Stop and ask

At a "limit reached" error from a web tool, or after 8 sources: stop, list the open sub-questions, and ask
"Reply **continue** to go on."

## Read-only

When an edit is denied (conflict), answer in the chat with the URLs you found, save nothing, and say why.

## Close

List the source files you saved and the pages you changed. The plan note stays as the run's record; the
user can delete it when reviewing the changes.
