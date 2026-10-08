---
feature: note-outline-properties
title: "Plan: note outline, note info and a properties editor"
status: applied
order: 4
created: 2026-10-04
edited: 2026-10-08
---

# Plan: note outline, note info and a properties editor

Each step is one red → green cycle. Nothing is mocked. Test layers:

- **Web units:** vitest in `apps/web/src/lib/*.test.ts`: `npm test -w apps/web -- <file>`.
- **e2e:** Playwright against the dev stack (`just dev` running): `just e2e <spec>`. Phone cases are
  tagged `@iphone` (390 px), tablet cases `@ipad` (820 px); untagged cases run on `desktop` (1280 px) and
  `webkit-desktop`. Test notes reach a vault through `pushFromObsidian(bare, path, content)`.
- **Full check:** `just check` (lint, typecheck, all unit and integration tests).

e2e fixture notes (pushed per test): `Long.md` with frontmatter (8 lines, 20 words), 30 headings over
levels 1–4 (one setext `===`, one setext `---`, one heading inside a `> [!note]` callout, one `# fake`
inside a code fence, one inside `%%…%%`) and a body of exactly 2,200 words; `Props.md` with the
frontmatter from the architecture's example (comment, single quotes, flow and block lists, block
scalar).

**Phase 1 (#79) is shippable on its own.** Its steps add no dependency and don't touch the frontmatter
text. Phase 2 (#82) can be split into its own change at any step boundary without reworking phase 1.

## Phase 1: outline and note info (#79)

- [x] `outlineOfText` lists ATX and setext headings with level and line
  - Test first: `apps/web/src/lib/outline.test.ts` › "ATX and setext headings, in order, with level and
    line". Text with `# A` (line 1), `## B` (line 3), `C` + `===` (lines 5–6), `D` + `---` (lines 8–9),
    `###### F` (line 11), `## G ##`. Expects `[{1,'A',1},{2,'B',3},{1,'C',5},{2,'D',8},{6,'F',11},{2,'G',…}]`.
    Fails today: `lib/outline.ts` doesn't exist.
  - Verify: `npm test -w apps/web -- outline` → green; `just check` → green.

- [x] Headings in code, frontmatter and comments are not in the outline
  - Test first: `outline.test.ts` › "skips fenced code, indented code, the frontmatter and %% comments".
    A note starting with `---` / `title: x` / `---` (the closing line would make `title: x` a setext h2),
    a ```` ``` ```` fence containing `# fake`, an indented `    # code`, and `%%` / `# hidden` / `%%`.
    Expects only the real headings, and line numbers that count the frontmatter. Fails today: the
    frontmatter yields a setext heading and the comment heading is listed.
  - Verify: `npm test -w apps/web -- outline` → green; `just check` → green.

- [x] Heading display text: wikilink labels, no emphasis marks, "(untitled)"
  - Test first: `outline.test.ts` › "display text". `## See [[notes/foo|Foo]] and **bold** _x_ ==y==
    `code`` → `See Foo and bold x y code`; `##` alone → `(untitled)`; `# A #` → `A`. Fails today: raw text
    is returned.
  - Verify: `npm test -w apps/web -- outline` → green; `just check` → green.

- [x] `currentHeading` finds the section at the top line
  - Test first: `outline.test.ts` › "current heading". Items at lines 3, 10, 20: top line 1 → -1, 3 → 0,
    15 → 1, 99 → 2; empty list → -1. Fails today: function missing.
  - Verify: `npm test -w apps/web -- outline` → green; `just check` → green.

- [x] Share `frontmatterEndLine` and `commentRanges` between `outline.ts` and `cm.ts`
  - Test first: none, refactor. `outline.test.ts` already covers both through `outlineOfText`; the
    existing `e2e/fix-58.spec.ts` (frontmatter block in Write mode) and `e2e/media.spec.ts` (no embeds in
    frontmatter or comments) pass before and after.
  - Verify: `rtk grep -n "function frontmatterEnd\b\|const inComment" apps/web/src/lib/cm.ts` → no match;
    `just e2e e2e/fix-58.spec.ts e2e/media.spec.ts` → green; `just check` → green.

- [x] `countText` and `readingMinutes`
  - Test first: `apps/web/src/lib/noteinfo.test.ts` › "words and characters". `"Hello, world!"` → 2 words,
    13 chars; `"## Über   die Straße"` → 3 words (the `##` doesn't count); `"l'été c'est"` → per the
    segmenter (assert the value `Intl.Segmenter` gives in Node, documented in the test);
    `"a\r\nb"` → 2 chars; `"👍🏽 é"` → 3 chars; `"[[foo|Bar]] *x*"` → 3 words. `readingMinutes(0)` → 0,
    `(1)` → 1, `(220)` → 1, `(221)` → 2, `(2200)` → 10. Fails today: module missing.
  - Verify: `npm test -w apps/web -- noteinfo` → green; `just check` → green.

- [x] Outline button and list in both modes
  - Test first: `e2e/outline.spec.ts` › "lists all headings with nesting, the same in Write and Read". Open
    `Long.md` in Write mode, click `outline-button`: `outline-item` count is 30 minus the fenced and the
    comment heading, `data-level` and text match the fixture, the callout heading is listed. Switch to
    Read mode: the same list. Open a media file: no `outline-button`. Fails today: no button.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] Jump in Write mode scrolls without moving the cursor or focusing
  - Test first: `outline.spec.ts` › "Write mode: tap scrolls the heading to the top, no focus". Put the
    cursor on line 2, blur, open the outline, tap a heading near the end: its line is within the top
    quarter of `.scroll`, `document.activeElement` isn't `.cm-content`, the selection head is unchanged,
    and `history.length` is unchanged. Same case tagged `@iphone`. Fails today: the tap does nothing.
  - Verify: `just e2e e2e/outline.spec.ts` → green on `desktop`, `webkit-desktop`, `iphone`,
    `webkit-iphone`; `just check` → green.

- [x] Jump in Read mode lands on the block and highlights it
  - Test first: `outline.spec.ts` › "Read mode: tap scrolls the heading's block to the top and highlights
    it". Tap a heading near the end: the `[data-line]` block with that line is within the top quarter and
    has class `hit`, gone after 2 s. Tap the heading inside the callout: the callout's block is at the top.
    Fails today: the tap does nothing in Read mode.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] The current section is marked while scrolling
  - Test first: `outline.spec.ts` › "current section follows the scroll". On `desktop` (panel stays open),
    in both modes scroll `.scroll` so heading `H` is at the top: the item for `H` has
    `aria-current="location"` and no other item has it; scroll back to the top: none has it. Fails today:
    nothing is marked.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] Phone sheet, tablet panel, wide panel: open and close rules
  - Test first: `outline.spec.ts` › "@iphone bottom sheet": `outline` has `aria-modal="true"` and its
    bottom edge is at the viewport's bottom above the tab bar; a jump closes it; reopening and tapping the
    scrim closes it; Escape closes it. › "@ipad panel": `aria-modal="false"`, inside the note pane, closes
    after a jump and on a tap outside. › "wide panel": stays open after a jump and after opening another
    note; the button closes it; with sidebar and chat open at 1024 px it fits inside the note pane. Fails
    today: no sheet or panel.
  - Verify: `just e2e e2e/outline.spec.ts` → green on all six projects; `just check` → green.

- [x] Note info counts the body, not the frontmatter
  - Test first: `outline.spec.ts` › "note info excludes the frontmatter". Open `Long.md`'s outline:
    `note-info` reads `2,200 words` and `~10 min read`, in both modes. Add a word to the frontmatter in
    Write mode: still 2,200; add one to the body: 2,201. Fails today: no note info.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] Note info follows the selection in both modes
  - Test first: `outline.spec.ts` › "selection-aware". Write mode: select from the middle of the
    frontmatter to the end of the first body paragraph (known 12 words): `note-info` reads
    `Selection: 12 words`. Read mode: select that paragraph in `.rd`: `Selection: 12 words`. Select a
    value in the #58 properties table: the full-note count shows. Clear the selection: the full-note
    count shows. The `@iphone` variant selects first, then taps the button (selection read on
    `pointerdown`). Fails today: the selection is ignored.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] The open outline passes the accessibility scan
  - Test first: `e2e/a11y.spec.ts` › "desktop shell" gains a scan with the outline open in Write and in
    Read mode, light and dark. Fails today: the `outline-button` locator doesn't exist.
  - Verify: `just e2e e2e/a11y.spec.ts` → green; `just check` → green.

- [x] README mentions the outline and note info
  - Test first: none, docs only.
  - Verify: `rtk grep -n -i "outline" README.md` → a match in the Status section.

- [x] Demo run book chapter for the outline and note info
  - Test first: none, docs only (CLAUDE.md "Demo run book"). `Karpathy Demo.md` in `~/git/karpathy_demo_wiki`
    gets a chapter: what it does, a long page that shows it, a *Try it* step; `updated` bumped. Not pushed
    until released.
  - Verify: `rtk grep -n -i "outline" ~/git/karpathy_demo_wiki/"Karpathy Demo.md"` → a match.

## Phase 2: properties editor (#82)

- [x] Add `yaml` and `fast-check`; the CST round trip holds on the fixture
  - Test first: `apps/web/src/lib/frontmatter.test.ts` › "yaml CST stringify is lossless". Parse the
    `Props.md` frontmatter with `new Parser().parse`, join `CST.stringify` of the tokens: equal to the
    input. Plus one trivial `fc.assert(fc.property(fc.string(), (s) => s === s))`. Fails today: `yaml`
    and `fast-check` can't be resolved. Add `yaml@^2.9.1` to `dependencies`, `fast-check@^4` to
    `devDependencies` of `apps/web`.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `readFrontmatter`: properties, kinds, line spans, editable flags, errors
  - Test first: `frontmatter.test.ts` › "reads properties". For `Props.md`: keys in order, `value`s,
    `lines` per pair, `list.flow` and `list.style`, the block scalar and a nested map are `raw` and not
    editable, `updated` inferred `date`, `[[…]]` lists inferred `links`. A frontmatter with a duplicate
    key, one that is a list, and one with a tab indent → `error` set. No frontmatter → `null`. Fails today:
    `readFrontmatter` missing.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `set` on a scalar changes only its value and keeps its style
  - Test first: `frontmatter.test.ts` › "set keeps quoting and comments". `confidence: 'high' # why` →
    set `medium` → `confidence: 'medium' # why`, every other line identical. Plain `updated: 2026-10-02` →
    `updated: 2026-10-04`. Text `title: x` set to `true`, `123`, `null`, `a: b`, `#x`, `[x]` → each
    written double-quoted and read back as that string. Fails today: `editFrontmatter` missing.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `set` on an empty value and `addKey`
  - Test first: `frontmatter.test.ts` › "empty value and new key". `done:` → set `2026-10-04` →
    `done: 2026-10-04`. `addKey confidence low` → one new last line; `addKey tags [a, b]` → `tags: [a, b]`.
    `addKey` for an existing key → refused. Fails today: not implemented.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `add` and `remove` list items in flow and block lists, in the list's style
  - Test first: `frontmatter.test.ts` › "list items". Flow `related: ["[[openai]]"]` + `tesla` →
    `related: ["[[openai]]", "[[tesla]]"]`. Flow bare `related: [dolomites]` + `tesla` →
    `[dolomites, tesla]`. Bare with `.md` items + `foo` → `foo.md`. Empty `[]` + `x` → `["[[x]]"]`. Block
    `sources:` with `  - "[[a]]"   # c` and `  - '[[b]]'` + `c` → a new line `  - "[[c]]"`, the comment
    kept. Remove first, middle, last in both forms → only that item and its separator or line gone.
    Fails today: not implemented.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `checkEdit` refuses anything that touches more than the edited property
  - Test first: `frontmatter.test.ts` › "invariant". Feed `checkEdit` hand-made `after` texts: a changed
    comment on another line, re-ordered keys, a re-quoted other value, a parse error, a value that reads
    back different from the intended one, an extra blank line → each returns a reason. The correct `after`
    → `null`. Then `editFrontmatter` on a value it can't splice safely (a flow list spanning two lines) →
    `{ refused }` and no text. Fails today: `checkEdit` missing.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] Property-based round-trip tests
  - Test first: `apps/web/src/lib/frontmatter.prop.test.ts` with the generators from the architecture
    (scalars in all styles, flow and block lists, quoted and bare wikilinks, comments, blank lines, block
    scalars, odd spacing) and its five properties: stringify identity; every edit refused or invariant
    holds with only the pair's lines changed; set-and-set-back identity; add-and-remove identity;
    refusals under 5 % of edits on editable values. `numRuns: 1000`. Fails today only if the
    implementation has gaps; any failing seed found while writing it becomes a fixed case in
    `frontmatter.test.ts` before the fix.
  - Verify: `npm test -w apps/web -- frontmatter` → green three times in a row (fresh seeds); `just check`
    → green.

- [x] Demo-vault corpus round trip
  - Test first: `frontmatter.test.ts` › "demo vault corpus". Fixture
    `apps/web/src/lib/fixtures/wiki-frontmatter.txt`: the frontmatters of all `Wiki/` pages of
    `karpathy_demo_wiki` (copied, separated by a marker line). For each editable property: set to a new
    value then back, add then remove a list item → byte-identical; none refused. Fails today: the fixture
    and test don't exist.
  - Verify: `npm test -w apps/web -- frontmatter` → green; `just check` → green.

- [x] `DEFAULT_SCHEMA`, `parseSchema` and `applies`
  - Test first: `apps/web/src/lib/schema.test.ts` › "schema file and scope". A valid file → `Schema`;
    unknown kind, `values` on a non-enum, a non-string value, invalid JSON → `{ error }`. `applies`:
    `Wiki/a.md` and `wiki/x/b.md` yes, `Sources/a.md` and `Wikis/a.md` no. Fails today: module missing.
  - Verify: `npm test -w apps/web -- schema` → green; `just check` → green.

- [x] `validate` flags violations and never changes values
  - Test first: `schema.test.ts` › "violations". On `Wiki/x.md`: `confidence: very-high` → "must be
    high, medium or low"; `updated: 2026-02-30` → "not a date (YYYY-MM-DD)"; missing `type` → "required
    on wiki pages"; `tags: foo` → "should be a list"; `related: [[[a]], "[[b]]"]` → "wikilinks in lists
    need quotes" for item 0; unknown keys (`kind`, `summit_m`) → nothing; the demo tour page → no
    violation. Same note under `Sources/` → no violations. The input object is deep-equal before and
    after. Fails today: `validate` missing.
  - Verify: `npm test -w apps/web -- schema` → green; `just check` → green.

- [x] Write mode shows the form and hides the frontmatter lines; YAML switch remembered
  - Test first: `e2e/properties.spec.ts` › "form view hides the frontmatter, YAML shows it". Open
    `Props.md` in Write mode: `props` is visible, `.cm-fm` count is 0, the first `.cm-line` is the line
    after the frontmatter. Click `props-yaml`: `props` rows gone, `.cm-fm` lines visible. Reload and open
    another note with frontmatter: still YAML. A note without frontmatter: no `props`. Read mode: the #58
    table, no `props`. Fails today: no form.
  - Verify: `just e2e e2e/properties.spec.ts e2e/fix-58.spec.ts` → green; `just check` → green.

- [x] Rows show kinds and violations
  - Test first: `properties.spec.ts` › "rows and flags". `Wiki/p.md` with the default schema fields plus
    `confidence: very-high` and `kind: tour`: `type` is a `select`, `updated` an `input[type=date]`,
    `related` shows link chips that open their note, `kind` a text input, the block scalar a read-only
    row with "Edit in YAML"; `props-violation` for `confidence` reads "must be high, medium or low". The
    same note under `Sources/` shows no violation. Fails today: rows aren't rendered.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] A form edit changes exactly one line of the saved file, and undo reverts it
  - Test first: `properties.spec.ts` › "one field, one line". Pick `high` for `confidence`, wait for
    "Saved": the file read through the `api` fixture differs from the pushed one in exactly that line.
    Tap **Today** on `updated`: one more line. Press undo in the editor (Mod-Z) twice and wait for
    "Saved": the file equals the pushed one byte for byte. A CRLF copy of `Props.md` keeps CRLF on every
    line. Fails today: the form can't edit.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] List chips: add with suggestions, remove, quoting follows the list
  - Test first: `properties.spec.ts` › "link chips". In `related: ["[[a]]"]` type `ide` in Add, pick the
    suggestion `Ideas`: the line becomes `related: ["[[a]]", "[[Ideas]]"]`. Remove `a`:
    `related: ["[[Ideas]]"]`. In a bare list `related: [dolomites]` add `Ideas`: `[dolomites, Ideas]`.
    `tags`: type `x` + Enter, `y` + Enter → two chips, the Add field keeps focus. Fails today: no chips.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] Stale and unsafe edits are refused; unreadable frontmatter opens the YAML view
  - Test first: `properties.spec.ts` › "never a lossy write". (1) With the form open,
    `pushFromObsidian` + a pull through the `api` fixture changes `type`: the form shows the new value and
    an edit made afterwards applies to the new text (no lost remote change). (2) A flow list spanning two
    lines is a read-only row; its "Edit in YAML" opens the YAML view for this note only, the file is
    unchanged. (Refusals of computed edits are covered by the unit and property tests.) (3) A note with a duplicate key opens with "Can't read these properties" and the YAML
    view; the preference is still `open` for the next note. Fails today: no form.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] A search hit or find-in-note match inside the frontmatter shows the YAML view
  - Test first: `properties.spec.ts` › "hits in the frontmatter are visible". Search a word that occurs
    only in `Props.md`'s frontmatter, open the hit in Write mode: the `.cm-fm` lines are visible and the
    hit line is selected. Find-in-note for that word does the same. Fails today: the form hides the line.
  - Verify: `just e2e e2e/properties.spec.ts e2e/fix-4.spec.ts` → green; `just check` → green.

- [x] The vault's schema file replaces the default and reloads on change
  - Test first: `properties.spec.ts` › "schema file". Push `.karpathy/schema.json` with
    `type: enum ['person']` and `appliesTo: ['People/']`: on `People/a.md` with `type: entity` the flag
    reads "must be person"; on `Wiki/p.md` no flag. Push a new schema file allowing `entity`: the flag
    disappears without a reload. Push invalid JSON: one toast "Schema file ignored", default rules apply.
    The tree shows no `.karpathy` folder, and chat stays enabled. Fails today: no schema is loaded.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] Phone keyboard and touch targets
  - Test first: `properties.spec.ts` › "@iphone form". Add fields have `enterkeyhint="done"`,
    `autocapitalize="off"`, `autocorrect="off"`; a number field has `inputmode="decimal"`; every button and
    input in `props` is at least 44 px high; the form fits 390 px without horizontal scroll; Enter in Add
    adds a chip and keeps the keyboard (focus stays). Fails today: no form.
  - Verify: `just e2e e2e/properties.spec.ts` → green on `iphone` and `webkit-iphone`; `just check` → green.

- [x] Read-only vaults show the form disabled
  - Test first: `properties.spec.ts` › "read-only in conflict". `makeConflict(api, vault)`, open
    `Props.md`: every input, select and chip button in `props` is disabled. Fails today: no form.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

- [x] The properties form passes the accessibility scan
  - Test first: `e2e/a11y.spec.ts` › "desktop shell" scans Write mode with the form open and a
    violation shown, light and dark. Fails today: the `props` locator doesn't exist.
  - Verify: `just e2e e2e/a11y.spec.ts` → green; `just check` → green.

- [x] README mentions the properties form and the schema file
  - Test first: none, docs only.
  - Verify: `rtk grep -n "karpathy/schema.json" README.md` → a match.

- [x] Demo run book chapter for the properties form
  - Test first: none, docs only (CLAUDE.md "Demo run book"). `Karpathy Demo.md` gets a chapter: the form,
    a wiki page with a flag to fix, the YAML switch, a *Try it* step; `updated` bumped. Not pushed until
    released.
  - Verify: `rtk grep -n "Properties" ~/git/karpathy_demo_wiki/"Karpathy Demo.md"` → a match.

## Review follow-ups

From `/spec:adversarial-code-review` (2026-10-08) and the user's decisions on it.

- [x] Typing stays fast with the outline open: Write mode reads the headings from the editor's syntax tree,
  and the outline and note info refresh after a pause, not per keystroke
  - Test first: `e2e/outline.spec.ts` › "typing in a long note with the outline open stays fast". A note of
    5,000 headings and 100,000 words; typing 40 characters with the outline open takes less than twice as
    long as with it closed, and the outline then lists the new heading. Fails today: every keystroke
    re-parses and re-counts the whole note.
  - Verify: `just e2e e2e/outline.spec.ts` → green; `just check` → green.

- [x] `validate` flags a value of the wrong kind
  - Test first: `schema.test.ts` › "wrong kind". With rules `n: number`, `b: boolean`, `t: text`: `n: high` →
    "should be a number", `b: yes` → "should be true or false", `t: [a]` → "should be a single value";
    `n: 3`, `b: true`, `t: x` → nothing. Fails today: no such check.
  - Verify: `npm test -w apps/web -- schema` → green; `just check` → green.

- [x] "+ Property" adds a missing schema key or a free key
  - Test first: `e2e/properties.spec.ts` › "+ Property". On `wiki/p.md` without `tags` and `confidence`:
    `props-add` offers `tags` and `confidence` (not `type`); picking `tags` writes `tags: []` as the last
    frontmatter line and its "required" flag goes away; a free key `rating` writes `rating: ""`; an
    invalid key (`a: b`) is refused with a toast, nothing written. Fails today: no `props-add`.
  - Verify: `just e2e e2e/properties.spec.ts` → green; `just check` → green.

System docs are updated at `/spec:archive`.
