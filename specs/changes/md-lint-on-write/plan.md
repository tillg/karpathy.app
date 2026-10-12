---
feature: md-lint-on-write
title: "Plan: check every Markdown file the AI writes"
status: applied
order: 4
created: 2026-10-12
edited: 2026-10-12
---

# Plan: check every Markdown file the AI writes

Steps 1–3 (the check), step 4 (the parser) and step 8 (the run book) don't build on each other.

## Lint library

- [x] `lintMarkdown` finds wrapped wikilinks
  - Depends on: none
  - Test first: `apps/backend/test/md-lint.test.ts` › "wikilink-wrapped". The cases are the real vault
    shapes: a plain wrap (`[[phi-hotel-canalgrande|Phi Hotel⏎Canalgrande]]` → line 1), a blockquote wrap
    (`> … [[x|Duchessa⏎> Margherita]]`), an indented list wrap, a double wrap, and an embed `![[a⏎b]]`.
    Negatives: a link on one line, `Type [[ to link …⏎… ![[image embeds]]` (clipped prose), `[[` inside a
    fenced block and inside an inline code span. It fails today because `deploy/opencode/lib/md-lint.ts`
    doesn't exist.
  - Verify: `npm test -w apps/backend -- md-lint` → green; `just test` → green
- [x] `lintMarkdown` finds unescaped alias pipes in table rows
  - Depends on: 1
  - Test first: `md-lint.test.ts` › "table-wikilink-pipe". The cases are `| [[nadine-gartner|Nadine]] | x |`
    (hit, line and fix text `[[nadine-gartner\|Nadine]]`) and an indented row. Negatives: an escaped
    `[[a\|b]]`, `[[a]]` without an alias, `[[a|b]]` outside a table, and `||` plus `[[a|b]]` inside a fenced
    Dataview block. It fails today because the rule is missing.
  - Verify: `npm test -w apps/backend -- md-lint` → green; `just test` → green
- [x] `writtenFiles` and `checkReport`
  - Depends on: 2
  - Test first: `md-lint.test.ts` › "written files". `edit`/`write` take `args.filePath`, and `apply_patch`
    takes `metadata.files[].filePath` + `movePath`. Non-`.md` paths are dropped, and `save_url` and `read`
    return `[]`. `md-lint.test.ts` › "report" checks that `checkReport` names the path, one line per
    finding with its rule, line and fix, and that it is empty for no findings. It fails today because the
    functions are missing.
  - Verify: `npm test -w apps/backend -- md-lint` → green; `just test` → green

## Wikilink parser

- [x] `parseWikilink` accepts the table-safe `\|` separator
  - Depends on: none
  - Test first: `packages/shared/src/wikilink.test.ts` › "escaped alias pipe" checks that
    `parseWikilink('nadine-gartner\\|Nadine')` → `{ target: 'nadine-gartner', alias: 'Nadine' }`, the same
    with `#heading`, and that `rewriteLinks` on a table row keeps `\|` (`relink.test.ts`). Then
    `apps/web/src/lib/markdown.test.ts` › "aliased wikilink in a table" checks that the row renders one
    `<a class="wl">` with label `Nadine` and the right cell count. `apps/web/src/lib/media.test.ts` ›
    "escaped pipe" checks that `parseEmbed('![[a.png\\|300]]')` → target `a.png`, width 300 (an embed in a table
    row gets the same fix). It fails today because the target comes out as `nadine-gartner\` / `a.png\`.
    The Read-mode table test passed before the fix, because `marked` unescapes `\|` in table cells
    before our tokenizer runs. It stays as a regression guard.
  - Verify: `just test` → green

## Plugin

- [x] Plugin `md-lint` appends the report after a write
  - Depends on: 3
  - Test first: `apps/backend/test/opencode-tools.test.ts` › "md-lint plugin". It checks that the container
    log shows `md-lint ready`. A unit test of the hook function goes in `md-lint.test.ts` › "hook": it
    calls the exported hook handler with a temp dir, a `write` input for a broken `.md` file, and an
    `output` object. Then `output.output` ends with the report, a clean file leaves it unchanged, a missing
    file or a throwing read leaves it unchanged, and a `.txt` file leaves it unchanged. It fails today
    because there is no plugin.
  - Verify: `npm test -w apps/backend -- md-lint opencode-tools` → green; `just test` → green
- [x] The image bake fails when `md-lint` doesn't load
  - Depends on: 5
  - Test first: none, because the change is in the build script. The check is the bake loop itself, and
    the container test from step 5.
  - Verify: `grep -q "md-lint ready" deploy/opencode/Dockerfile` and
    `npm test -w apps/backend -- opencode-tools` → green (rebuilds the image)

## End to end

- [x] The model fixes what the check reports
  - Depends on: 6
  - Test first: `apps/backend/test/chat.llm.test.ts`, `@llm Markdown check (#118)`. It was revised during
    apply. The first version ("the file is clean after the turn", on the 3B dev model) failed: qwen2.5:3b
    ignored the report, and it also stopped after the escalation (a refused `write`), which was then
    dropped (grill Q1 revised, architecture Key decisions). Now there are two tests:
    - "the report of a broken write reaches the model": any model. The three table lines are given in the
      prompt, so the broken row reaches the disk. The tool result of that write in the opencode session
      carries `Markdown problems in …people.md … [table-wikilink-pipe]`.
    - "the AI fixes broken Markdown it wrote (hosted model)": runs only with `LLM_TEST_MODEL=openrouter/…`.
      A natural prompt asks for a table with Nadine linked as "Nadine". After the turn the file is clean
      and has `[[nadine-gartner\|Nadine]]`.
  - Verify: `cd apps/backend && npx vitest run --project llm -t "Markdown check"` → green, plus
    `OPENROUTER_API_KEY=… LLM_TEST_MODEL=openrouter/z-ai/glm-5.3 npx vitest run --project llm -t "Markdown
    check"` → both green (`npm run test:llm -- -t …` loses the flag in the nested npm call)
- [x] Demo run book: chapter "Clean Markdown from the AI"
  - Depends on: none
  - Test first: none, because the change is in docs. The chapter is in `~/git/karpathy_demo_wiki/Karpathy
    Demo.md`: what the check does, a demo page with a table of aliased wikilinks, and a *Try it* step ("ask
    the AI to add a row with `[[page|alias]]` to the table; the file shows `\|`"). Bump `updated`. Don't
    push until release.
  - Verify: `grep -q "Clean Markdown" ~/git/karpathy_demo_wiki/"Karpathy Demo.md"`

- [x] One-off cleanup of the existing breaks in `frechen_wiki` and `mylife_wiki` (grill Q7)
  - Depends on: 3, 4
  - Test first: none, because this is vault content, not app code. The finder is `lintMarkdown` from
    step 1–3, run over each vault's `.md` files by a throwaway script in `tmp/`. The fix is mechanical:
    put the link on one line, and write `\|` in table rows. Show the user the diff per vault and commit
    only after their OK, one commit per vault. Don't push without asking.
  - Verify: the same script reports 0 findings in both vaults, and `git -C ~/git/<vault> log -1` shows the
    cleanup commit

## Review fixes (`/spec:adversarial-code-review`)

- [x] Fix the findings that need no decision
  - Depends on: 1, 2, 3, 4, 5
  - Test first: `apps/web/src/lib/cm.test.ts` › "#118 the table-safe [[target\|alias]] resolves its target":
    the editor's live preview marked `[[x\|y]]` as missing (`cm.ts` split at the bare `|`).
    `md-lint.test.ts` › "review fixes" covers:
    - a fence line with an info string doesn't close a block
    - CRLF paragraph breaks and wraps
    - frontmatter is skipped, and the line numbers after it hold
    - HTML comments are skipped
    - a row counts only in a table with a delimiter row, also inside a blockquote
    - a short pipe link after a long one (a global regex kept its state)
    - `[[a||b]]` gets both pipes escaped
    - a snippet with a backtick is shown with a double-backtick span
    - an unexpected read error is logged
    All fail before the fix except the logging case, which covers the existing path.
  - Verify: `just test` → green; `npm run lint && npm run typecheck` → clean

System docs are updated at `/spec:archive`.
