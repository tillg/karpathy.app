---
feature: attachments
title: "Plan: uploads and chat attachments"
status: proposed
order: 4
created: 2026-10-04
edited: 2026-10-04
---

# Plan: uploads and chat attachments

Each step is one red → green cycle. Nothing is mocked: real git clones, the real opencode container
(`kai-test-opencode`), real browsers. Test layers:

- **Shared and web units:** vitest, `npm test -w packages/shared` and `npm test -w apps/web -- <file>`.
- **Backend:** vitest with the real app and a real vault clone (`apps/backend/test/api.test.ts`, `vaultApp()`), and the
  real opencode container for chat (`apps/backend/test/chat.test.ts`): `npm test -w apps/backend -- <file>`.
- **e2e:** Playwright against the dev stack (`just dev` running): `just e2e <spec>`. `cspGuard` fails a test on any CSP
  violation. The CSP exists only in the prod proxy, so the last phase also runs `just prodtest e2e`.

New fixtures in `e2e/fixtures/media/` are tiny real files, made once on the Mac and checked in:

- `photo.jpg`: 3000×2000 JPEG with EXIF orientation 6 and a GPS tag (`exiftool`), about 300 KB;
- `photo.heic`: the same picture as HEIC (`sips -s format heic photo.jpg --out photo.heic`);
- `shot.png` (400×300) and `doc.pdf` (exists);
- `word.png`: the word "KIWI" in large black letters on white, for the vision test.

Playwright feeds files with `setInputFiles`, and drops with a `DataTransfer` built in `page.evaluateHandle`. Phone
projects (`iphone`, `webkit-iphone`) run the tests tagged `@iphone`.

Obsidian's `app.json` settings are not read (architecture, Key decisions), so there is no Obsidian check before
phase 1.

## Phase 1: shared table, link resolver and upload route

- [ ] Shared `UPLOADABLE`, `isUploadable`, `uploadMime` and the limits
  - Test first: `packages/shared/src/media.test.ts` › "uploadable files".
    - `isUploadable` is true for `'a/B.JPG'`, `.jpeg`, `.png`, `.gif`, `.webp` and `.pdf`.
    - It is false for `.heic`, `.svg`, `.avif`, `.mp4`, `.md` and `png` (no dot).
    - `uploadMime('x.JPG') === 'image/jpeg'`, and `'x.pdf' → 'application/pdf'`.
    - `MAX_UPLOAD_BYTES === 50 MiB`.

    It fails today: no such exports.
  - Verify: `npm test -w packages/shared` → green; `just check` → green.

- [ ] Move the wikilink resolver to `packages/shared` (refactor)
  - Test first: the existing `apps/web/src/lib/wikilink.test.ts` passes before and after. It moves with the code to
    `packages/shared/src/wikilink.test.ts`. `apps/web` re-exports from shared, so no web import changes.
  - Verify: `npm test -w packages/shared` and `npm test -w apps/web` → green; `just check` → green.

- [ ] `POST /vaults/:id/raw` stores the bytes as a new file next to a page in its own folder
  - Test first: `apps/backend/test/api.test.ts` › "upload: stores bytes, returns path and version". Seed
    `Wiki/foo/foo.md`. POST a 3-byte body `application/octet-stream` to `/raw?name=a.png&note=Wiki/foo/foo.md`.
    Expect:
    - 201 `{ path: 'Wiki/foo/a.png', version, size: 3 }` and no `moved`;
    - the file on disk has exactly those bytes;
    - `version` equals `GET /file`'s version;
    - `GET /changes` lists the path;
    - the AI-touched set is empty.

    Also upload to `note=Sources/x/index.md` → `Sources/x/a.png`. It fails today: 404, no route.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

- [ ] Uploads never overwrite; names are unique in the whole vault, case-insensitively
  - Test first: `api.test.ts` › "upload: -2, -3 on collisions, vault-wide, case-insensitive".
    - Upload `x.png` twice → `x.png`, then `x-2.png`.
    - With an existing `Wiki/foo/Y.png`, upload `y.png` → `y-2.png`.
    - With an existing `Other/deep/w.png` (another folder), upload `w.png` to `Wiki/foo/foo.md` → `Wiki/foo/w-2.png`.
    - Ten parallel uploads of `z.png` → ten distinct paths, every file intact.

    It fails today: no route.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] Uploads are refused when not uploadable, too large, badly named, in conflict or unauthenticated
  - Test first: `api.test.ts` › "upload: refusals".
    - `name=a.heic` → 415 `not-uploadable`; `a.svg` → 415.
    - A body of `MAX_UPLOAD_BYTES + 1` bytes → 413, and no file is written.
    - `name=a|b.png`, `name=sub/a.png`, `name=.a.png` and `name=opencode.json` → 400 `bad-name`.
    - `note=../x.md` → 400 `bad-path`.
    - Both `note` and `source`, or neither → 400.
    - Vault in conflict (`makeConflict`) → 423.
    - No token → 401.

    A 2 MB JSON `PUT /file` still works, because the raw parser is scoped. It fails today: no route.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

## Phase 2: move a page into its own folder

- [ ] The first upload to a flat page moves it into its own folder
  - Test first: `api.test.ts` › "upload: flat page moves into its own folder". With no `app.json`, seed
    `Wiki/serien/foo.md`, then upload `a.png` with `note=Wiki/serien/foo.md`. Expect:
    - `201 { path: 'Wiki/serien/foo/a.png', moved: { from: 'Wiki/serien/foo.md', to: 'Wiki/serien/foo/foo.md' } }`;
    - the old file gone, and the new one with the same bytes;
    - `GET /changes` lists both paths and `a.png`.

    The same with `{"attachmentFolderPath":"Assets"}` in a committed `.obsidian/app.json`: it is ignored. Also: a
    root-level `foo.md` → `foo/foo.md`; `Sources/x/x.md` is already in its own folder. `Wiki/Foo/foo.md` (case differs) counts as its own folder, and
    `Sources/x/index.md` is never moved. An existing `Wiki/serien/foo/` holding only images is fine. It fails today:
    nothing moves, so the upload lands next to the flat page.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] The move is refused while an AI turn runs or when the target exists
  - Test first: `api.test.ts` › "upload: move refusals".
    - `Wiki/serien/foo/foo.md` exists → `409 folder-taken`, and so does a case twin `Wiki/serien/foo/FOO.md`.
    - Busy state `turn` (hold the vault lock as `ChatService` does) → `409 ai-busy`.

    In all cases nothing changed on disk and no `a.png` was written. It fails today: no move.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] `rewriteLinks` rewrites path-form links that resolve to the moved page, and nothing else
  - Test first: `packages/shared/src/relink.test.ts`, a pure function over text, old path, new path and the file list.
    Cases, for a move from `Wiki/serien/foo.md` to `Wiki/serien/foo/foo.md`:
    - `[[serien/foo]]`, `[[serien/foo|Foo]]` and `![[serien/foo#Plot]]` → the same with `serien/foo/foo`;
    - `[[Wiki/serien/foo.md]]` → `[[Wiki/serien/foo/foo.md]]`;
    - from `Wiki/x.md`, `[F](serien/foo.md)` → `[F](serien/foo/foo.md)`;
    - from `Wiki/a/b.md`, `[F](../serien/foo.md)` → `[F](../serien/foo/foo.md)`;
    - `[[foo]]` unchanged;
    - `[[filme/foo]]` unchanged when it resolves to `Wiki/filme/foo.md`;
    - a link inside a fenced block or a code span unchanged.

    Inside the moved page: `![](img/a.png)` → `![](../img/a.png)`, `[x](../other.md)` → `[x](../../other.md)`, and
    `![[a.png]]` unchanged. It fails today: no module.
  - Verify: `npm test -w packages/shared` → green.

- [ ] The move rewrites inbound links across the vault and keeps AI-touched marks
  - Test first: `api.test.ts` › "upload: move rewrites path-form links".
    - Seed `Wiki/a.md` containing `[[serien/foo]] and [[foo]]` and `Wiki/b.md` containing `[[filme/foo]]`.
    - Upload to `Wiki/serien/foo.md`.
    - The response's `rewritten` is `['Wiki/a.md']`. `a.md` now reads `[[serien/foo/foo]] and [[foo]]`, and `b.md`
      is byte-identical.
    - With `Wiki/serien/foo.md` in the AI-touched set before, the set has `Wiki/serien/foo/foo.md` after.
    - If `Wiki/a.md` changes on disk between the scan and the write, the move fails with `409 stale`, and
      `Wiki/serien/foo.md` is still in place.

    It fails today: links aren't touched.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

## Phase 3: upload from the editor

- [ ] `uploadName` builds safe names without a date prefix
  - Test first: `apps/web/src/lib/attach.test.ts`, with `now = 2026-10-04 14:30:12`.
    - camera → `photo-20261004-143012.jpg`;
    - `IMG_1234.HEIC` (converted) → `IMG_1234.jpg`;
    - `a#b[c]|d^e?.PNG` → `a-b-c-d-e.png`;
    - `.hidden.pdf` → `hidden.pdf`;
    - `my scan.pdf` → `my scan.pdf`;
    - a 200-character stem is cut to 80;
    - `con.pdf` → `con-file.pdf`.

    It fails today: no module.
  - Verify: `npm test -w apps/web -- attach` → green.

- [ ] `prepare` shrinks JPEG and HEIC, drops metadata, passes the rest through
  - Test first: `e2e/attach.spec.ts` › "photo preparation". In the page, run `prepare` on `photo.jpg` (via
    `page.evaluate` on a `File` built from the fixture bytes). Expect:
    - result type `image/jpeg`;
    - long edge 2048: decode it and read `naturalWidth`/`naturalHeight`, which give portrait 1365×2048 because of
      orientation 6;
    - no `Exif` marker (`0xFFE1`) in the bytes;
    - a size below the input's.

    `shot.png` and `doc.pdf` come back byte-identical. In `webkit-desktop`, `photo.heic` → JPEG 1365×2048. In
    `desktop` (Chromium) it rejects with "HEIC photos can't be converted in this browser". This runs in browsers,
    because canvas and `createImageBitmap` don't exist in vitest. It fails today: no module.
  - Verify: `just e2e e2e/attach.spec.ts` → green on `desktop` and `webkit-desktop`.

- [ ] The editor's Attach button uploads and inserts an embed at the cursor
  - Test first: `e2e/attach.spec.ts` › "attach in the editor inserts an embed".
    1. Open `Wiki/home/home.md` (own folder) in Write mode, put the cursor at the end of line 2, click `attach` →
       `attach-choose`, and `setInputFiles(shot.png)`.
    2. Assert that a `.cm-embed img` appears below line 3 with `naturalWidth === 400`.
    3. Assert that the saved note (via `api.read`) has `![[shot.png]]` on its own line after line 2 and is otherwise
       unchanged.
    4. Assert that `api.changes` lists `Wiki/home/shot.png`, and the tree shows it.
    5. Type a character during a slow upload (`page.route` delaying the POST): the embed still lands at the original
       cursor position.
    6. Cmd+Z removes the embed line; `Wiki/home/shot.png` still exists and is still in `api.changes`.

    It fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts e2e/editing.spec.ts e2e/media.spec.ts` → green on `desktop` and
    `webkit-desktop`; `just check` → green.

- [ ] The editor follows its page when the upload moves it
  - Test first: `e2e/attach.spec.ts` › "attach to a flat page moves it, the editor follows".
    1. Push `Wiki/flat.md` and `Wiki/ref.md` (containing `[[Wiki/flat]]`), then open `flat.md` in Write mode.
    2. Type `hello` and attach `shot.png` with the POST delayed. Type ` world` during the delay.
    3. Assert that the route becomes `#/<vault>/Wiki/flat/flat.md` with no new history entry (`history.length`
       unchanged), and the editor still shows the page with `hello world` and the embed.
    4. Assert that after autosave `Wiki/flat/flat.md` holds that text, `Wiki/flat.md` doesn't exist, `ref.md` reads
       `[[Wiki/flat/flat]]`, and the toast says "updated links in 1 page".
    5. Reload: the local draft key follows, and no "unsaved" warning about the old path appears.
    6. With an AI turn running (`@llm`-free: hold the busy state through the test helper), the attach shows "The AI
       is working" and nothing moves.
    7. Multi-pick `shot.png` and `doc.pdf` on a fresh flat `Wiki/flat2.md`: the POSTs go out one after another
       (record request start/end times with `page.on('request')`/`'requestfinished'`), the first names
       `note=Wiki/flat2.md` and the second `note=Wiki/flat2/flat2.md`, and both files land in `Wiki/flat2/` with
       their embeds in order.

    It fails today: no move.
  - Verify: `just e2e e2e/attach.spec.ts` → green on `desktop` and `webkit-desktop`.

- [ ] Dropping files on the note uploads them at the drop point
  - Test first: `e2e/attach.spec.ts` › "drop files into the editor".
    1. Open `Wiki/home/home.md` in Write mode.
    2. Dispatch `dragenter`/`dragover`/`drop` on the line-4 coordinates with a `DataTransfer` holding `shot.png` and
       `doc.pdf`.
    3. Assert that during `dragover` the editor has `cm-drop-target`.
    4. Assert that after the drop line 4 is followed by `![[shot.png]]` and `![[doc.pdf]]` on consecutive lines, the
       cursor didn't jump to the end, and no file name was inserted as plain text.
    5. Drop a `.txt` and a `.png` together: one toast names the `.txt`, and the PNG is embedded.
    6. Drop in Read mode: nothing is uploaded, and the page doesn't navigate to the file.

    Runs on `desktop` (Chromium). On `webkit-desktop`, a synthesized `DataTransfer` drop with files isn't reliable,
    so the device check in phase 6 covers Safari by hand. It fails today: CodeMirror inserts the file name.
  - Verify: `just e2e e2e/attach.spec.ts --project desktop` → green.

- [ ] A name taken elsewhere gets a suffix and still embeds bare; the button hides where it can't work
  - Test first: `e2e/attach.spec.ts` › "embed text and button visibility".
    1. With `Other/shot.png` pushed first (`pushFromObsidian`), attaching `shot.png` to `Wiki/home/home.md` inserts
       `![[shot-2.png]]`, and it renders the new file.
    2. `attach` is absent in Read mode, on a media file, offline (`context.setOffline`) and in conflict
       (`makeConflict`).
    3. The `attach-photo` input has `capture="environment"` and `accept="image/jpeg"`.
    4. The `attach-choose` input's `accept` is exactly `image/jpeg,image/png,image/gif,image/webp,application/pdf`
       (no wildcard, no HEIC).

    It fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts` → green on `desktop` and `webkit-desktop`.

- [ ] Large files ask first; refusals show a toast
  - Test first: `e2e/attach.spec.ts` › "growth warning and refusals".
    - A generated 11 MB PDF (`Buffer.alloc` with a `%PDF-` header) triggers a `dialog` whose message contains
      "11 MB" and "git history". Dismissing it sends no POST, and accepting it uploads the file.
    - A `.txt` file via `setInputFiles` (bypassing `accept`) shows the toast "Only JPEG, PNG, GIF, WebP and PDF can be
      uploaded." and changes nothing.

    It fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts` → green.

## Phase 4: chat attachments

- [ ] Chat uploads create one source folder per message
  - Test first: `api.test.ts` › "upload: source folders".
    - `name=photo.jpg&source=new&at=2026-10-04-091500` → `Sources/upload-2026-10-04-091500/photo.jpg`.
    - `name=doc.pdf&source=upload-2026-10-04-091500` → `Sources/upload-2026-10-04-091500/doc.pdf`.
    - A second `source=new` with the same `at` and `x.jpg` → `Sources/upload-2026-10-04-091500-2/x.jpg`.
    - `source=new` without `at`, or with `at=yesterday` or `at=../x` → 400.
    - `source=../Wiki`, `source=mail-x` and `source=upload-missing` → 400 `bad-path`.
    - A vault with `sources/` (lower case) → `sources/upload-…`, and no `Sources/` is created.

    It fails today: no `source` parameter.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] The prompt body accepts attachments and the queue keeps them
  - Test first: `apps/backend/test/chat.test.ts` › "prompt with attachments is queued and survives a restart".
    - POST `{ text: '', attachments: ['Sources/upload-x/a.png'] }` → 202; `{ text: '' }` → 400; six paths → 400.
    - Restart the `ChatService` from the same config store: the queued turn still has its attachment
      (`config.json` holds the path, no bytes).
    - The chat title becomes `a.png`.

    It fails today: `text` must be non-empty, and there's no `attachments` field.
  - Verify: `npm test -w apps/backend -- chat` → green.

- [ ] A turn sends the attachment to opencode as a file part
  - Test first: `chat.test.ts` › "attachment reaches opencode as a file part". Upload `shot.png` through the API with
    `source=new`, and prompt with it. The default tier's model doesn't exist in Ollama, so the turn fails fast.
    Assert on the stored session through the real opencode container: the user message has a `file` part with
    `mime: 'image/png'`, `filename: 'Sources/upload-…/shot.png'` and a `data:image/png;base64,` URL whose bytes
    equal the file.

    This works without a model: opencode stores the user message (`createUserMessage`, `session/prompt.ts` 1057)
    before the run loop resolves the model (1141). The existing test "prompt runs a turn" already reads the stored
    user message after such a failed turn. It fails today: only a text part is sent.
  - Verify: `npm test -w apps/backend -- chat` → green; `just check` → green.

- [ ] Attachment paths are checked at turn start
  - Test first: `chat.test.ts` › "bad attachment paths end the turn".
    - Prompt with `Sources/upload-x/gone.png` (never existed) → stream event `error` "Attachment not found:
      Sources/upload-x/gone.png", the turn goes idle, and nothing is sent to opencode (the session has no new user
      message).
    - The same for `../other-vault/x.png`, `.env`, `Notes/n.md` (not uploadable) and a 21 MB PDF (over
      `MAX_ATTACHMENT_BYTES`).
    - A file discarded while the turn is queued behind another turn fails the same way.

    It fails today: attachments are not read.
  - Verify: `npm test -w apps/backend -- chat` → green.

- [ ] History shows attachments as file parts, never as data URLs
  - Test first: `apps/backend/test/harness-map.test.ts` › "user file part maps to a file chat part". Capture the
    stored message from the previous step as a fixture.
    - `mapMessages` yields `{ type: 'file', path: 'Sources/upload-…/shot.png', mime: 'image/png' }`, and no string
      in the output contains `data:`.
    - A file part without a filename maps to nothing.
    - Synthetic "Called the Read tool…" text stays hidden.

    It fails today: the `file` part is dropped (`default` branch).
  - Verify: `npm test -w apps/backend -- harness-map` → green.

- [ ] Settings report what the model can read
  - Test first: `chat.test.ts` (it has the opencode container) › "settings expose modelInput".
    - With the test container's provider config, give the Ollama test model
      `modalities: { input: ['text', 'image'] }`: `GET /settings` → `modelInput: { image: true, pdf: false }`.
    - With a model id opencode doesn't list → `modelInput: null`.
    - `PATCH /settings` returns it too.

    It fails today: no fields.
  - Verify: `npm test -w apps/backend -- chat api` → green; `just check` → green.

- [ ] The composer attaches, shows chips and sends
  - Test first: `e2e/attach.spec.ts` › "attach in the chat".
    1. In a new chat, `chat-attach` → `setInputFiles([shot.png, doc.pdf])`. Assert two chips (`attach-chip`), one
       with a thumbnail `img` and one with "doc.pdf" and its size, both in the same `Sources/upload-…/` folder.
    2. `✕` on the PDF chip removes it and deletes `doc.pdf` (gone from disk and from Changes); the PNG and its folder
       stay. Removing the last chip too deletes the folder, and the next file sends `source=new` again.
    3. Reload with one chip unsent: the chip comes back with its thumbnail. Delete its file through the API and
       reload: the chip is gone.
    4. Send with empty text. The user message shows a `.embed img` for the PNG, rendered through `/raw`, not a
       `data:` URL: assert the `src` starts with `blob:` and a `/raw?path=` request happened.
    5. Reload: still shown. Delete the file and reload: a `miss` file card.
    6. The next message's first file gets a new folder, named after the browser's local time (`upload-YYYY-MM-DD-HHMMSS`
       with the page's clock set through `page.clock`).
    7. With the dev model (text only, `modelInput.image === false`), the chip shows "can't see images".
    8. A sixth file → the picker refuses with "At most 5 files per message".

    It fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts e2e/chat.spec.ts` → green on `desktop` and `webkit-desktop`; `just check` →
    green.

- [ ] Phone layout: the chips and the menu fit
  - Test first: `e2e/attach.spec.ts` › "@iphone attach menu and chips fit the composer". On the phone projects:
    1. Open the chat and tap `chat-attach`. Both `attach-photo` and `attach-choose` are visible and at least 44 px
       high.
    2. Add five chips. The composer scrolls the chips row horizontally, the send button stays in the viewport, and
       the page has no horizontal scroll (`scrollWidth <= clientWidth`).

    It fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts --grep @iphone` → green on `iphone` and `webkit-iphone`.

- [ ] A vision model reads an attached image (`@llm`)
  - Test first: `apps/backend/test/chat.llm.test.ts` › "@llm the model reads an attached image".
    - This needs a vision model: add `qwen2.5vl:3b` to `deploy/opencode/dev-ollama.json` with
      `"modalities": { "input": ["text", "image"], "output": ["text"] }`, selected through `LLM_VISION_MODEL`
      (default `ollama/qwen2.5vl:3b`).
    - Upload `word.png` and prompt "Use the write tool to create Notes/seen.md containing only the word in the
      attached image."
    - Assert a write tool event for `Notes/seen.md`, and that the file contains `kiwi` (case-insensitive).
    - A turn without a tool call is *inconclusive*: one retry, per the `@llm` rules.

    It fails today: the image never reaches the model.
  - Verify: `npm test -w apps/backend -- chat.llm` with the vision model pulled → green.

## Phase 5: production check and docs

- [ ] Uploads and chips pass the prod CSP and proxy
  - Test first: none new, because the CSP can only be proven on the prod images. Run
    `just prodtest e2e e2e/attach.spec.ts` before any proxy change. It is expected to be green without a change
    (`connect-src 'self'`, `img-src blob:`, no Caddy body limit). If it fails, fix the cause; don't widen the CSP
    without a new decision.
  - Verify: `just prodtest` (rebuild), then `just prodtest e2e e2e/attach.spec.ts e2e/media.spec.ts` → green;
    `rtk git diff --stat deploy/proxy` → empty.

## Phase 6: device check

- [ ] Visual and device check
  - Test first: none, because this is visual and hardware. It is covered by the e2e above, then checked by eye per
    the global rule.
  - Verify:
    - **Screenshots:** Playwright MCP screenshots at 1× of the editor right after an upload (the embed below the
      line), of the drop outline during a drag, and of the composer with five chips. Take them at iPhone width and
      at 1280 px, and look at the last chip and the right edge. Save them to `tmp/`, and name in the report what was
      checked.
    - **Safari on the Mac:** drag two screenshots from Finder onto a note. They land at the drop point.
    - **Real iPhone**, in the installed home-screen app (ask the user):
      - **Take photo** opens the camera directly;
      - **Choose file** offers library, camera and Files;
      - a library photo stored as HEIC arrives as `.jpg`;
      - a `.heic` picked from Files is converted or refused with the message.

      Record what iOS did in the report.
    - **Obsidian on the Mac**, after a commit and pull: the moved page, its image and a rewritten `[[…/…]]` link all
      work.

- [ ] README: mention uploads, drag and drop, own folders and chat attachments
  - Test first: none, docs.
  - Verify: `rtk grep -n -i "attach\|drag" README.md` → matches the new lines; `just check` → green.

System docs are updated at `/spec:archive`.
