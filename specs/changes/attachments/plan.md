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
  violation; the CSP exists only in the prod proxy, so the last phase also runs `just prodtest e2e`.

New fixtures in `e2e/fixtures/media/`, tiny real files made once on the Mac and checked in:

- `photo.jpg`: 3000×2000 JPEG with EXIF orientation 6 and a GPS tag (`exiftool`), about 300 KB;
- `photo.heic`: the same picture as HEIC (`sips -s format heic photo.jpg --out photo.heic`);
- `shot.png` (400×300) and `doc.pdf` (exists);
- `word.png`: the word "KIWI" in large black letters on white, for the vision test.

Playwright feeds files with `setInputFiles`. Phone projects (`iphone`, `webkit-iphone`) run the tests tagged
`@iphone`.

## Phase 1: shared table and upload route

- [ ] Shared `UPLOADABLE`, `isUploadable`, `uploadMime` and the limits
  - Test first: `packages/shared/src/media.test.ts` › "uploadable files". `isUploadable('a/B.JPG')`, `.jpeg`, `.png`,
    `.gif`, `.webp`, `.pdf` → true; `.heic`, `.svg`, `.avif`, `.mp4`, `.md`, `png` (no dot) → false.
    `uploadMime('x.JPG') === 'image/jpeg'`, `'x.pdf' → 'application/pdf'`. `MAX_UPLOAD_BYTES === 50 MiB`. Fails today:
    no such exports.
  - Verify: `npm test -w packages/shared` → green; `just check` → green.

- [ ] `POST /vaults/:id/raw` stores the bytes as a new file
  - Test first: `apps/backend/test/api.test.ts` › "upload: stores bytes, returns path and version". POST a 3-byte body
    `application/octet-stream` to `/raw?name=2026-10-04-a.png&note=Notes/n.md`. Expect 201 `{ path:
    'Sources/media/2026-10-04-a.png', version, size: 3 }`; the file on disk has exactly those bytes; `version` equals
    `GET /file`'s version; `GET /changes` lists the path; the AI-touched set is empty. Fails today: 404, no route.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

- [ ] Uploads never overwrite; case twins count as taken
  - Test first: `api.test.ts` › "upload: -2, -3 on collisions, case-insensitive". Upload `x.png` twice → `x.png`,
    `x-2.png`. With an existing `Sources/media/Y.png`, upload `y.png` → `y-2.png`. Ten parallel uploads of `z.png` →
    ten distinct paths, every file intact. Fails today: no route.
  - Verify: `npm test -w apps/backend -- api` → green.

- [ ] Uploads are refused when not uploadable, too large, badly named, in conflict or unauthenticated
  - Test first: `api.test.ts` › "upload: refusals". `name=a.heic` → 415 `not-uploadable`; `a.svg` → 415; a body of
    `MAX_UPLOAD_BYTES + 1` bytes → 413 and no file written; `name=a|b.png` → 400 `bad-name`; `name=sub/a.png` → 400;
    `name=.a.png` → 400; `name=opencode.json` → 400; `note=../x.md` → 400 `bad-path`; vault in conflict
    (`makeConflict`) → 423; no token → 401. A 2 MB JSON `PUT /file` still works (the raw parser is scoped). Fails
    today: no route.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

- [ ] The attachment folder follows `.obsidian/app.json`
  - Test first: `api.test.ts` › "upload: attachment folder". Write `.obsidian/app.json` into the clone and upload with
    `note=Notes/Day.md`: no file → `Sources/media/`; `{"attachmentFolderPath":"/"}` → vault root;
    `"./"` → `Notes/`; `"./img"` → `Notes/img/`; `"Assets/Pics"` → `Assets/Pics/`; `"../out"` and `".hidden"` →
    `Sources/media/`; invalid JSON → `Sources/media/`. Without `note` (chat), `"Assets"` is ignored →
    `Sources/media/`. A vault with `sources/` (lower case, `structure` variant of `makeRemote`) → `sources/media/`,
    and no `Sources/` folder is created. A vault with a subfolder root reads `<root>/.obsidian/app.json`. Fails today:
    no route.
  - Verify: `npm test -w apps/backend -- api` → green.

## Phase 2: upload from the editor

- [ ] `uploadName` builds safe, dated names
  - Test first: `apps/web/src/lib/attach.test.ts` › uploadName with `now = 2026-10-04 14:30:12`. Camera → `2026-10-04-photo-143012.jpg`.
    `IMG_1234.HEIC` (converted) → `2026-10-04-IMG_1234.jpg`. `a#b[c]|d^e?.PNG` → `2026-10-04-a-b-c-d-e.png`.
    `.hidden.pdf` → `2026-10-04-hidden.pdf`. `2025-01-01-scan.pdf` → unchanged (no double date). A 200-character stem
    is cut to 80. `con.pdf` → `2026-10-04-con.pdf` (the date prefix avoids reserved names). Fails today: no module.
  - Verify: `npm test -w apps/web -- attach` → green.

- [ ] `prepare` shrinks JPEG and HEIC, drops metadata, passes the rest through
  - Test first: `e2e/attach.spec.ts` › "photo preparation". In the page, run `prepare` on `photo.jpg` (via
    `page.evaluate` on a `File` built from the fixture bytes): result type `image/jpeg`, long edge 2048 (decode it and
    read `naturalWidth`/`naturalHeight`: portrait 1365×2048 because of orientation 6), no `Exif` marker
    (`0xFFE1`) in the bytes, size below the input's. `shot.png` and `doc.pdf` come back byte-identical. In
    `webkit-desktop`, `photo.heic` → JPEG 1365×2048; in `desktop` (Chromium) it rejects with "HEIC photos can't be
    converted in this browser". This runs in browsers because canvas and `createImageBitmap` don't exist in vitest.
    Fails today: no module.
  - Verify: `just e2e e2e/attach.spec.ts` → green on `desktop` and `webkit-desktop`.

- [ ] The editor's Attach button uploads and inserts an embed at the cursor
  - Test first: `e2e/attach.spec.ts` › "attach in the editor inserts an embed". Open `Home.md` in Write mode, put the
    cursor at the end of line 2, click `attach` → `attach-choose`, `setInputFiles(shot.png)`. Assert: a `.cm-embed img`
    appears below line 3 with `naturalWidth === 400`; the saved note (via `api.read`) has `![[2026-…-shot.png]]` on
    its own line after line 2 and is otherwise unchanged; `api.changes` lists `Sources/media/2026-…-shot.png`; the
    tree shows it. Type a character during a slow upload (`page.route` delaying the POST): the embed still lands at
    the original cursor position. Fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts e2e/editing.spec.ts e2e/media.spec.ts` → green on `desktop` and
    `webkit-desktop`; `just check` → green.

- [ ] Ambiguous basenames get the full path; the button hides where it can't work
  - Test first: `e2e/attach.spec.ts` › "embed text and button visibility". With `Other/2026-…-shot.png` pushed first
    (`pushFromObsidian`) and a fixed clock (`page.clock`), the inserted text is `![[Sources/media/2026-…-shot.png]]`.
    `attach` is absent in Read mode, on a media file, offline (`context.setOffline`) and in conflict
    (`makeConflict`). The `attach-photo` input has `capture="environment"` and `accept="image/jpeg"`; the
    `attach-choose` input's `accept` is exactly `image/jpeg,image/png,image/gif,image/webp,application/pdf` (no
    wildcard, no HEIC). Fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts` → green on `desktop` and `webkit-desktop`.

- [ ] Large files ask first; refusals show a toast
  - Test first: `e2e/attach.spec.ts` › "growth warning and refusals". A generated 11 MB PDF (`Buffer.alloc` with a
    `%PDF-` header) triggers a `dialog` whose message contains "11 MB" and "git history"; dismissing it sends no POST.
    Accepting uploads it. A `.txt` file via `setInputFiles` (bypassing `accept`) shows the toast "Only JPEG, PNG, GIF,
    WebP and PDF can be uploaded." and changes nothing. Fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts` → green.

## Phase 3: chat attachments

- [ ] The prompt body accepts attachments and the queue keeps them
  - Test first: `apps/backend/test/chat.test.ts` › "prompt with attachments is queued and survives a restart". POST
    `{ text: '', attachments: ['Sources/media/a.png'] }` → 202; `{ text: '' }` → 400; six paths → 400. Restart the
    `ChatService` from the same config store: the queued turn still has its attachment (`config.json` holds the path,
    no bytes). The chat title becomes `a.png`. Fails today: `text` must be non-empty, no `attachments` field.
  - Verify: `npm test -w apps/backend -- chat` → green.

- [ ] A turn sends the attachment to opencode as a file part
  - Test first: `chat.test.ts` › "attachment reaches opencode as a file part". Upload `shot.png` through the API,
    prompt with it. The default tier's model doesn't exist in Ollama, so the turn fails fast; assert on the stored
    session through the real opencode container: the user message has a `file` part with `mime: 'image/png'`,
    `filename: 'Sources/media/…shot.png'` and a `data:image/png;base64,` URL whose bytes equal the file. This works
    without a model: opencode stores the user message (`createUserMessage`, `session/prompt.ts` 1057) before the run
    loop resolves the model (1141), and the existing test "prompt runs a turn" already reads the stored user message
    after such a failed turn. Fails today: only a text part is sent.
  - Verify: `npm test -w apps/backend -- chat` → green; `just check` → green.

- [ ] Attachment paths are checked at turn start
  - Test first: `chat.test.ts` › "bad attachment paths end the turn". Prompt with `Sources/media/gone.png` (never
    existed) → stream event `error` "Attachment not found: Sources/media/gone.png", turn idle, nothing sent to
    opencode (session has no new user message). The same for `../other-vault/x.png`, `.env`, `Notes/n.md`
    (not uploadable) and a 21 MB PDF (over `MAX_ATTACHMENT_BYTES`). A file discarded while the turn is queued behind
    another turn fails the same way. Fails today: attachments are not read.
  - Verify: `npm test -w apps/backend -- chat` → green.

- [ ] History shows attachments as file parts, never as data URLs
  - Test first: `apps/backend/test/harness-map.test.ts` › "user file part maps to a file chat part". Capture the
    stored message from the previous step as a fixture: `mapMessages` yields `{ type: 'file', path:
    'Sources/media/…shot.png', mime: 'image/png' }` and no string in the output contains `data:`. A file part without a
    filename maps to nothing. Synthetic "Called the Read tool…" text stays hidden. Fails today: the `file` part is
    dropped (`default` branch).
  - Verify: `npm test -w apps/backend -- harness-map` → green.

- [ ] Settings report what the model can read
  - Test first: `chat.test.ts` (it has the opencode container) › "settings expose modelInput". With the test
    container's provider config, give the Ollama test model `modalities: { input: ['text', 'image'] }`:
    `GET /settings` → `modelInput: { image: true, pdf: false }`. With a model id opencode doesn't list →
    `modelInput: null`. `PATCH /settings` returns it too. Fails today: no field.
  - Verify: `npm test -w apps/backend -- chat api` → green; `just check` → green.

- [ ] The composer attaches, shows chips and sends
  - Test first: `e2e/attach.spec.ts` › "attach in the chat". In a new chat, `chat-attach` → `setInputFiles([shot.png,
    doc.pdf])`: two chips (`attach-chip`), one with a thumbnail `img`, one with "doc.pdf" and its size; `✕` on the
    PDF chip removes it (the uploaded file stays in the vault and in Changes). Send with empty text: the user message
    shows a `.embed img` for the PNG (rendered through `/raw`, not a `data:` URL: assert the `src` starts with
    `blob:` and a `/raw?path=` request happened). Reload: still shown. Delete the file and reload: a `miss` file card.
    With the dev model (text only, `modelInput.image === false`), the chip shows "can't see images". Sixth file → the
    picker refuses with "At most 5 files per message". Fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts e2e/chat.spec.ts` → green on `desktop` and `webkit-desktop`; `just check` →
    green.

- [ ] Phone layout: the chips and the menu fit
  - Test first: `e2e/attach.spec.ts` › "@iphone attach menu and chips fit the composer". On the phone projects: open
    the chat, tap `chat-attach`: both `attach-photo` and `attach-choose` are visible and at least 44 px high. Add five
    chips: the composer scrolls the chips row horizontally, the send button stays in the viewport, and the page has
    no horizontal scroll (`scrollWidth <= clientWidth`). Fails today: no button.
  - Verify: `just e2e e2e/attach.spec.ts --grep @iphone` → green on `iphone` and `webkit-iphone`.

- [ ] A vision model reads an attached image (`@llm`)
  - Test first: `apps/backend/test/chat.llm.test.ts` › "@llm the model reads an attached image". Needs a vision model:
    add `qwen2.5vl:3b` to `deploy/opencode/dev-ollama.json` with `"modalities": { "input": ["text", "image"],
    "output": ["text"] }`, selected through `LLM_VISION_MODEL` (default `ollama/qwen2.5vl:3b`). Upload `word.png`,
    prompt "Use the write tool to create Notes/seen.md containing only the word in the attached image." Assert a write
    tool event for `Notes/seen.md` and that the file contains `kiwi` (case-insensitive). A turn without a tool call is
    *inconclusive*, one retry, per the `@llm` rules. Fails today: the image never reaches the model.
  - Verify: `npm test -w apps/backend -- chat.llm` with the vision model pulled → green.

## Phase 4: production check and docs

- [ ] Uploads and chips pass the prod CSP and proxy
  - Test first: none new; the CSP can only be proven on the prod images. Run `just prodtest e2e e2e/attach.spec.ts`
    before any proxy change. Expected green without a change (`connect-src 'self'`, `img-src blob:`, no Caddy body
    limit). If it fails, fix the cause, don't widen the CSP without a new decision.
  - Verify: `just prodtest` (rebuild), then `just prodtest e2e e2e/attach.spec.ts e2e/media.spec.ts` → green;
    `rtk git diff --stat deploy/proxy` → empty.

- [ ] Visual and device check
  - Test first: none, visual and hardware. Covered by the e2e above, then checked by eye per the global rule.
  - Verify: Playwright MCP screenshots at 1× of the editor right after an upload (the embed below the line) and of the
    composer with five chips, at iPhone width and at 1280 px; look at the last chip and the right edge. Save to
    `tmp/`, and name in the report what was checked. On a real iPhone, in the installed home-screen app (ask the
    user): **Take photo** opens the camera directly; **Choose file** offers library, camera and Files; a library photo
    stored as HEIC arrives as `.jpg`; a `.heic` picked from Files is converted or refused with the message; record
    what iOS did in the report.

- [ ] README: mention uploads and chat attachments
  - Test first: none, docs.
  - Verify: `rtk grep -n -i "attach" README.md` → matches the new lines; `just check` → green.

System docs are updated at `/spec:archive`.
