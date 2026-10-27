---
title: "Architecture: karpathy.app"
created: 2026-10-01
edited: 2026-10-27
---

# Architecture: karpathy.app

As built on 2026-10-02. This page describes what exists; the reasons behind it are in
[Design decisions](#design-decisions) and the [ADRs](../../docs/adr/).

## Overview

A thin backend in front of git and an agent harness, a PWA in front of the backend, and an ingest service that fills
the vaults' `Input/` from mail and the web, all in one docker compose stack. Only the reverse proxy publishes ports.

```mermaid
flowchart LR
  subgraph Device["Phone / iPad / Mac"]
    PWA[PWA: React + CodeMirror 6<br/>service worker, local drafts]
  end
  subgraph Stack["docker compose (project karpathy-app)"]
    P[proxy: Caddy<br/>TLS, CSP, static PWA]
    B[backend: Node/Express<br/>vault, file, git, chat API]
    O[opencode serve<br/>agent loop + tools]
    E[egress: Squid<br/>public addresses only]
    I[ingest: ingest-email<br/>mail + links into Input/]
    V[(volume vaults:<br/>git clones)]
    C[(volume config:<br/>config.json)]
    OD[(volume opencode-data)]
    IST[(volume ingest-state:<br/>Gmail token, Instagram session,<br/>worker results)]
  end
  subgraph Home["User's Mac / Linux box (home IP)"]
    W[Instagram worker<br/>karpathy-instagram-worker]
  end
  GH[(GitHub)]
  LLM[LLM provider]
  WEB[(Exa, public web)]
  GI[(Gmail API, Instagram,<br/>linked pages)]
  IGH[(Instagram)]
  PWA -- "HTTPS, Bearer token,<br/>JSON + NDJSON" --> P
  W -- "HTTPS (tailnet), worker token,<br/>job routes only" --> P
  W --> IGH
  P -- "/api/*" --> B
  B -- "@opencode-ai/sdk (HTTP + SSE),<br/>Basic auth" --> O
  B -- "/instagram/* :8090,<br/>ingest token (jobs streamed)" --> I
  B -- "git, ripgrep" --> V
  B --> C
  O -- "file tools" --> V
  O --> OD
  I -- "Input/ rw, Sources/ ro" --> V
  I --> IST
  B -- "fetch / push (token header)" --> GH
  O -- "HTTP(S)_PROXY" --> E
  I -- "HTTP(S)_PROXY" --> E
  E -- "model API" --> LLM
  E -- "web search, web fetch" --> WEB
  E -- "mail, links" --> GI
```

## Technology stack

| Layer | Technology |
|---|---|
| Web | React 19, Vite 8, TypeScript, CodeMirror 6 (`lang-markdown`, own live-preview decorations), `marked` 18 + DOMPurify, vite-plugin-pwa (Workbox), framework7-icons. No router library (hash routes), no state library (one context hook). |
| Backend | Node 22, Express, TypeScript run with `tsx` (no build step), zod validation, chokidar, `@opencode-ai/sdk` v2, `git`, `ripgrep` and `gitleaks` (the commit's secret scan, pinned) binaries; vault search: MiniSearch 7 (BM25 index), `@orama/stemmers` (Snowball), `franc-min` (language detection). |
| Agent harness | `opencode serve` 1.18.25 (pinned image `ghcr.io/anomalyco/opencode`), provider-agnostic; gateway and default model per environment from `deploy/settings/` (OpenRouter `z-ai/glm-5.3` in production, dev, prodtest and every test: no local model server). |
| Proxy | Caddy 2.10 built with a `caddy-dns/<provider>` module (GoDaddy) for DNS-01. |
| Shared | `packages/shared`: TypeScript types for the API (no runtime schemas). |
| Settings | `packages/settings`: zod schema, loader, secret resolution and renderer for `deploy/settings/` (YAML), run with `tsx` as `just settings …` ([Settings](#settings)). |
| Ingest | Python 3.13 image running [ingest-email](https://github.com/tillg/ingest_email) (private repo, pinned commit) with instascraper 1.1.0, the `gog` Gmail CLI 0.43.0 (checksum-verified), tesseract (deu, eng), poppler and ffmpeg; a stdlib `http.server` endpoint ([Ingest service](#ingest-service-deployingest)). |
| Instagram worker | Python ≥ 3.11 package `karpathy_instagram_worker` in `tools/instagram-worker/` (not a release image): instascraper v1.1.0 as a library, stdlib HTTP (`urllib`, `http.client`), config TOML; installed with pipx from a git tag, run by launchd (macOS) or a systemd user unit (Linux) ([Instagram worker](#instagram-worker-toolsinstagram-worker)). |
| Tests | Vitest (backend projects `default`, `github`, `llm`; web unit tests for `lib/` and component tests with `@testing-library/react` in jsdom), pytest (the ingest endpoint, in the image's test stage; the Instagram worker in a `python:3.11-slim` container with instascraper stubbed, `tools/instagram-worker/test.sh`), shell tests (`*.test.sh`), Playwright e2e (desktop, iPad, iPhone in Chromium and WebKit), axe-core. |
| Website | Plain HTML + CSS in `site/`, no framework or dependencies; tests with `node:test`; GitHub Pages. |
| Tooling | npm workspaces (`apps/*`, `packages/*`, `site`), ESLint flat config, `just`, GitHub Actions CI. |

## Components

### Web app (`apps/web`)

- **Shell** with three panes (sidebar, note, chat) laid out per breakpoint: phone ≤ 699 px (tab bar, push navigation),
  tablet 700–1023 px (overlays), wide ≥ 1024 px (columns). On the wide layout the **swap button** (`#main-swap`,
  rendered by `Shell` while the chat is open) toggles the main pane: class `chatmain` on `#app` swaps the two columns
  with CSS `order`/`flex` only, so no DOM node moves (a running stream, typed text, focus, scroll and undo history
  survive). The button is one absolutely positioned 44 px element on the divider (`right: 380px + inset`, the side
  column is always 380 px); the bar ends next to it get 32 px padding. The choice lives in the store (`chatMain`,
  localStorage `karpathy.chatMain`).
- **Note graph** (`GraphPane`, #130): a layer inside `#detail` (absolute, over the note), shown while the store's
  `graphOpen` is set (sidebar graph button; `openNote` clears it). The note underneath stays mounted and `inert`, so
  drafts, cursor and scroll survive. It fetches `GET /vaults/:id/graph` on the first open per vault and keeps the
  result in a module-level `Map` for the session (Refresh drops it; an open `.md` note missing from it fetches it again,
once per note, so a note made since gets its local graph); the `3d-force-graph` instance is built once per
  data and only paused while hidden, so reopening is instant. three.js is imported dynamically so the main bundle
  stays without it; the chunk (~1.4 MB) stays under Workbox's 2 MiB precache limit. Offline, a first open shows the
  fetch error. `lib/graph.ts` decides what is shown (`shownGraph`: the `Wiki` folder, any case, unless the bar's
  Local | Wiki | All is on All or the vault has none) and the colours (`typeColors`: the node's frontmatter `type`, read by the backend; `entity` =
  `--tint`, untyped = `--label3`, other types `--graph-1…6` by name; `withoutTypes` drops the types unchecked in the
  legend, kept in localStorage `karpathy.graphHiddenTypes`). The same node objects feed both views, so
  toggling keeps the layout. A CSS-only "breathing graph" shows until the first engine tick. Node labels are DOM
  elements with `textContent`, never HTML strings; a `ResizeObserver` keeps the canvas at the pane size.
  **Local graph** (#92): the store's `graphScope` (`local` | `wiki` | `all`, session only) picks the view; the
  outline's "Local graph" sets `local` and opens the pane. `localGraph` (`lib/graph.ts`) takes the notes within the
  depth (1 or 2, localStorage `karpathy.graphDepth`) of the open note over the same `/graph` data, following links both
  ways, and every link between them; `localView` drops the hidden types first (`withoutTypes`, which keeps the
  centre) and then takes the neighbourhood, so a hidden note bridges nothing in. Only the local view depends on the open
  note: in Wiki / All a note switch only repaints. On the same `3d-force-graph` instance the local
  view switches to `numDimensions(2)` on its own node objects (so the vault's 3D layout is untouched; going back sets
  3 before handing the vault's nodes back), stronger charge and faster alpha decay, one-finger/left-button pan, and
  `nodeThreeObject` name sprites (canvas text, cached per note, disposed with the graph). The camera fits the notes
  (`zoomToFit`) a few times while the layout settles and on engine stop. The canvas isn't keyboard or screen-reader
  reachable, so the local view also renders its notes as an `sr-only` list of buttons that call `openNote`.
- **Bases** (`lib/base.ts`, #91): `mountBase(host, source, ctx, onEdit?)` builds the table with `createElement` /
  `textContent` (plain DOM, like embeds) from `POST /vaults/:id/base`. Read mode: `marked`'s `code` renderer turns a
  `base` fence into `<div class="base-block" data-base="…">` (marked with the render's `ek`, so a note's raw HTML
  can't forge one; DOMPurify trims the attribute) and `Markdown` mounts every placeholder (`mountBases`). Write mode:
  a `StateField` in `lib/cm.ts` (`bases`) finds closed `FencedCode` nodes with info `base` after the frontmatter and
  replaces each with a block `BaseWidget` while no selection range touches it; `ignoreEvent` keeps taps in the table,
  the `</>` button puts the cursor on the block's first line. `.base` files are file kind `base` (page mode, like HTML;
  `BaseFileView`). Results are cached per vault and source (a re-mount shows the last one at once) and stale once the
  vault's epoch moves: the store calls `baseChanged(vault)` on every `files-changed` event, shown tables re-run 300 ms
  later. Width: `contain: inline-size` on the box, `.base-scroll` scrolls sideways.
- **Chat opens notes** (`lib/chat.ts`, `ChatPane` `useChat`): a pure open tracker per chat view (`seen`, `later`,
  `loaded`). The first history load only marks completed `open_note` calls as seen; later loads (reattach,
  visibility change) and live events open unseen completed calls. Outside the wide layout the last open of the turn
  waits for `idle`. `show(path)` checks `isEditing()` (editor focused or unsaved text) at that moment: open the note,
  or toast "AI opened …". A completed open renders as an "opened" chip that reopens the note.
- **Store** (`store.tsx`): one `useAppState` hook in a React context holds the token, vaults, status, open note, save
  pipeline (autosave 1.5 s, drafts, retries), the vault event stream and routing (`#/<vault>/<path>`, and `#admin` /
  `#admin/<section>` for admin mode: `admin`, `adminVault`, `openAdmin`, `setAdminSection`, `adminUp`, `closeAdmin`).
  Its event handler also answers browser calls for this tab (see **Browser tools** below).
- **Client context and browser tools** (#151): `lib/client-context.ts` gives the tab id (random, `sessionStorage`
  `karpathy.tab`) and `clientContext()` = `{ tabId, timeZone, locale }`, sent with every prompt; `lib/browser-tools.ts`
  holds the handlers (`user_location`), see [Browser tools and local time](#browser-tools-and-local-time).
- **Editor** (`Editor.tsx`, `lib/cm.ts`): CodeMirror 6 with decorations only, so the Markdown text, frontmatter and
  `[[wikilinks]]` round-trip losslessly; CRLF kept; external reloads applied as one minimal change. Embeds come from a
  `StateField` (block decorations must come from state): per line with an embed, a block widget after the line end
  (`side: 1`) that calls `mountEmbed`; not in fenced code or frontmatter; recomputed on `docChanged` and on
  `refreshLinks`. `EditorHandle` has `topLine()` and `gotoLine(line, { focus: false, align: 'start' })` for mode
  switches (no keyboard on a phone), `track(at?)` (a position mapped through later changes, whose `insert(embed)`
  puts `![[name]]` on its own line as one isolated undo step and returns false once the editor is gone) and
  `setDoc(text)` (the reload's minimal change, applied at once). A `domEventHandlers` drop handler takes file drops
  (`posAtCoords`, outline class `cm-drop-target`) and leaves text drags to CodeMirror. See [Uploads](#uploads).
  For the outline and the properties form the handle also has `outline()` (headings from the syntax tree),
  `selectionText()`, `applyChange(change, expect)`, and the props `onFrontmatter`, `hideFrontmatter`,
  `onRevealFrontmatter`, `onSelection`; see [Outline and properties](#outline-and-properties).
  The prop `kind: 'note' | 'code'` picks the extension set: `note` is the above; `code` (code files and an HTML page's
  Write mode) is `codeView(path)`: a `language` compartment, empty first and filled with the language's support once
  its lazy chunk loads (text shows at once, colors a moment later; a chunk that can't load leaves plain text),
  `defaultHighlightStyle`, line wrapping, a monospace class, and **none** of live Markdown, wikilinks, embeds,
  frontmatter hiding or the drop handler. EOL handling, history, search, `readOnly`, autosave and drafts are shared.
  See [Text files](#text-files).
- **File kinds** (`lib/lang.ts`, #126): `fileKind(path, binary)` is the one place that decides — `media` when
  `mediaKind(path)` (so `.svg` is media although its bytes are text), else `email` (`.eml`, #166, before the text
  check), else `binary`, else `note` (`.md`/`.markdown`), `html` (`.html`/`.htm`) or `code`. `languageFor(path)` = `LanguageDescription.matchFilename` over
  `@codemirror/language-data` (extensions and full names like `Dockerfile`), `null` = plain text. `NotePane` routes by
  kind: `media`/`binary` → `MediaView`; `code` → the editor only (no toggle, outline, properties, attach; title keeps
  the extension; "Delete file"); `html` → toggle on `pageMode`, Write = code view, Read = `HtmlView`; `email` →
  `EmailView` (no toggle, `viewMode` = Read). `newNote` writes `# <title>` only for a note. See [Text files](#text-files)
  and [Emails](#emails).
- **Back arrow** (`store.tsx` `syncRoute`, `NotePane`, #139): every file route's history entry carries
  `{ prev: <path left> | null }` (`prev` only when the entry left is a file route of the same vault; a replace keeps
  the replaced entry's `prev`; `popstate` fills it in for entries the browser made itself, `history.state === null`).
  The store's `canGoBack` follows `history.state?.prev` after every `syncRoute` and `popstate`; `goBack()` =
  `history.back()`, and the existing `popstate` handler opens the file and restores its place. The header button
  `data-testid="note-back"` (icon `arrow_uturn_left`, tooltip `Back to <file name>`) shows while `canGoBack`; on the
  phone it sits after `data-testid="back"`, which then drops its label, and the phone header has no ✦ chat toggle.
- **Chat list and context meter** (`ChatPane`, `components/ContextMeter.tsx`, `lib/time.ts`, #140): rows show
  `chatTime(lastEntryAt ?? updatedAt)` (time today, date + time this year, date with year + time before, in the
  browser's locale) and a `bar` meter, in the backend's order. `Conversation` shows the `full` meter above the
  composer from the last assistant message with `context`; `applyChatEvent` replaces message info on `message`
  events, so it follows the stream. `ContextMeter` (`bar` / `full`): a 3 px `role="meter"` track (`aria-valuenow/max`),
  `full` adds `used / limit` via `Intl.NumberFormat(locale)` and the tooltip `<p> % of <model>'s context · drops when
  the chat is compacted`; level classes ok < 70 % ≤ warn < 90 % ≤ crit (theme tokens); no limit → `full` shows
  `<used> tokens`, `bar` renders nothing.
- **Outline and note info** (`lib/outline.ts`, `lib/noteinfo.ts`, `OutlinePanel`): see
  [Outline and properties](#outline-and-properties).
- **Properties form** (`lib/frontmatter.ts`, `lib/schema.ts`, `PropertiesPanel`, `Linked`): see
  [Outline and properties](#outline-and-properties).
- **Commands** (`lib/commands.ts`, `ChatPane`, `Dialogs.tsx` `MoveNotice`): the command palette, command chips and the
  agents-move notice; see [Commands](#commands) and [The agents move](#the-agents-move).
- **Media** (`lib/media.ts`, `lib/embed.ts`, shared `MEDIA` table): see [Media embeds](#media-embeds).
- **File tree sort and filter** (`lib/tree.ts`, `FileTree.tsx`, `TreeMenu.tsx`): see [File dates](#file-dates).
  `buildTree(entries, sort, filter)` sorts and filters client-side (no request on a switch, works on the cached
  listing). The choice is `sortFilter` in the store (localStorage `karpathy.treeSort` / `karpathy.treeFilter`).
  `TreeMenu` is the header's icon button with a menu of `menuitemradio` groups.
- **Input count and Ingest button** (`lib/tree.ts` `inputCount`, `FileTree.tsx`, `Shell.tsx`, store `ingestNow`): see
  [Ingest](#ingest).
- **Mode preference** (`store.tsx`): `mode` (notes) is read from and written to localStorage `karpathy.mode`,
  `pageMode` (HTML pages, default `read`) to `karpathy.pageMode`; `switchMode` writes the one that matches the open
  file's kind, and `openNote` never changes either. An in-memory `places` map (`vault\0path` → scroll top, top line, mode) is filled when a note is left
  and restored on Back/Forward; `lib/place.ts` maps between source lines and Read-mode blocks.
- **Renderer** (`lib/markdown.ts`): `marked` with extensions (wikilinks and embeds, highlights, footnotes; callouts and
  task markers via renderer overrides; `%%comments%%` stripped outside code) + DOMPurify for Read mode and chat text. A
  per-call `afterSanitizeAttributes` hook sets link targets: wikilinks and resolved relative links get app routes,
  external links `target="_blank" rel="noopener noreferrer"`. `renderMarkdown(md, ctx)` takes `{ exists,
  resolveEmbed }`; `![[…]]` (an inline extension before `wikilink`) and `![alt](src)` (the `image` renderer) emit a
  `<span class="embed" data-path data-kind data-width data-alt>` placeholder, never an `<img src>`. Each top-level
  block carries `data-line` (its source line, frontmatter included) on its own tag, no wrapper elements; Read mode
  uses it for hit positions and mode switches.
- **API client** (`lib/api.ts`, `lib/ndjson.ts`): fetch wrapper with Bearer token, typed `ApiError`, NDJSON reader.
- **Admin mode** (#150; full design in [Admin mode](#admin-mode)): the admin form of the hash route (`lib/route.ts`),
  the store's `admin` state, and these components:

  | Module | Responsibility |
  |---|---|
  | `components/AdminMode.tsx` | The shell of admin mode: rail (`nav.admin-rail`, wide and tablet) or section list (phone), section header with **Done** / "‹ Admin", Escape, focus handling, the phone list's summaries |
  | `components/Admin.tsx` | The section bodies `GeneralSection`, `VaultsSection`, `SecretsSection`, `AiSection` and their forms (`CommitReminderForm`, `AiForm` over `useSettingsSave`; the vault list, details, Add vault, `VaultHelp`, `GitHubTokenForm`, `Versions`) |
  | `components/SecretTable.tsx` | Deployment secrets table and "N of M set" (`secretsSummary`) |
  | `components/UsageSection.tsx`, `ServerSection.tsx` | The Usage and Server sections; they fetch `GET /usage` and `GET /metrics` |
  | `components/charts/` | `Sparkline`, `StackedBars`, `Tip` (hover tooltip, `NoData`): inline SVG, no chart library |
  | `lib/route.ts` | `ADMIN_SECTIONS`, `AdminSection`, `formatAdminRoute`, `parseRoute` (`Route.admin`) |
  | `lib/percent.ts` | `percent`, `pct`: shared by Usage and Server |

  `Shell` renders `AdminMode` while `admin !== null` and keeps the user-mode `#app` mounted but `hidden`. The vault
  list, vault details, help `Modal` and confirm `Modal` (missing folders) are unchanged. `InstagramNotice` ("Reconnect
  in Secrets & keys", or in worker mode "Details" / "Workers in Secrets & keys") switches the section.
- **Service worker**: precaches the app shell; `vault-api` NetworkFirst cache (5 s timeout) for the vault list, file
  tree and opened notes; auto-update with a re-check whenever the app becomes visible.

### Website (`site/`)

Not part of the app or its stack: the public product page at https://karpathy.app, deployed to GitHub Pages
on its own ([deployment.md › Website](deployment.md#website)).

- `index.html` (start page: hero with logo and a link to the origin, features, "See it on every device" with the
  three screenshots, how it works, "Where the idea comes from" — Karpathy's post as a static `<blockquote cite>`
  card linking to X and his gist as a card, no embed script —, "Code, not a service" with what self-hosting takes, a
  hosting contact) and `style.css` (the app's `:root` token blocks, copied, plus the page's layout; the Mac shot
  spans the width, iPad and iPhone share the row below, all stack at phone width).
- `screenshots/{mac,ipad,iphone}.webp`: the website screenshots, each `<img>` with its real `width`/`height`,
  `loading="lazy"`, linked to the full file. `capture.mjs` takes them from `just prodtest` (WebKit, the device
  classes of [domain.md](domain.md)); it is a dev tool, not deployed.
- `build.sh` assembles `_site/` from the page files, `screenshots/` and `assets/icons/`; all paths are relative, so
  the page also works under `tillg.github.io/karpathy.app/`.
- `site.test.mjs` runs the build and checks the output, including token equality with `apps/web/src/styles.css`.

```mermaid
flowchart TB
  H[hero + origin link] --> F[features] --> SS["#screenshots<br/>Mac · iPad · iPhone"] --> HW["#how"] --> OR["#origin<br/>post + gist"] --> SH["#self-host + hosting contact"]
```

### Backend (`apps/backend`)

| Module | Responsibility |
|---|---|
| `main.ts` | Loads the settings (`SETTINGS_FILE`, default `/etc/karpathy/settings.json`), reads the container wiring from env (`PORT`, `VAULTS_DIR`, `CONFIG_DIR`, `OPENCODE_URL`, `OPENCODE_VAULTS_DIR`; `INGEST_URL` and `INGEST_TOKEN_FILE` for the ingest endpoint, both or none) and the build/deploy facts (`APP_VERSION`, `BUILT_AT`, `DEPLOYED_AT`), wires the services (the `UsageService` over the harness, the `MetricsSampler`, started with `await metrics.start()`, `settings.secrets` into `createApp`), graceful shutdown (stops the sampler). |
| `settings.ts` | `loadBackendSettings(path)`: parses the rendered `settings.json` with the backend's own zod schema and reads each `{ file }` secret; a missing or invalid file stops the start with the path and the failing key. The schema also accepts `secrets`, the rendered secret manifest (`SecretStatus` without the GitHub extras; defaults to `[]`, so an older `settings.json` still loads) and exposes it as `BackendSettings.secrets`. |
| `app.ts` | Express routes under `/api`, error mapping, NDJSON writer (15 s keepalive). `/healthz` outside auth; `/api/health` also reports the release version (`APP_VERSION`, `dev` for local builds), which admin mode › General shows next to the PWA's own. New in #150: `GET /api/settings/secrets`, `GET /api/usage` and `GET /api/metrics` ([Admin mode](#admin-mode)). |
| `auth.ts` | Bearer token check (hashed, constant-time compare); `bearerAuthAny(tokens)`, the same check against each of several tokens (the Instagram worker routes). |
| `vaults.ts` | Vault lifecycle (add with preflight, clone, patch, remove), file API, search, status (incl. `inputChangedCount`), events, commit/push/discard, conflict resolution; per-vault runtime state; per-vault token access check (`checkAccess`). Reads the GitHub token through a getter per git operation. Runs the agents move after clone, pull and open (`agentsMove`), keeps the last result (`lastAgentsMove`) and counts running commit-message proposals (`proposing`, `isProposing`). |
| `agents-standard.ts` | The agents move: `scanLegacy`, `migrateToAgents`, `restageSkillLink` ([The agents move](#the-agents-move)); also `readFrontmatter`. |
| `preflight.ts` | `preflight()`: the attach check ([Attach preflight](#attach-preflight)); `REQUIRED_FOLDERS`. |
| `github-token.ts` | `GitHubToken`: the server-wide token (stored over secret), its source, `GET /user` identity check, redaction of every value seen. |
| `ingest.ts` | `callIngest`: proxies the Instagram routes to the ingest service's endpoint ([Ingest](#ingest)); `forwardIngest`: passes a job-route request (JSON, or a streamed body with its `Content-Length`) through and returns the service's status, type and body as they are. |
| `ingest-worker.ts` | `ingestWorkerRouter`: the Instagram worker's five job routes, mounted at `/api/ingest/instagram` before the main router, on the worker or the main token ([Instagram worker and job API](#instagram-worker-and-job-api)). `UPLOAD_TIMEOUT_MS` (10 min). |
| `serve.ts` | `serve(app, port)`: starts the HTTP server with `requestTimeout` = the upload timeout + 1 min (Node's 300 s default would cut a slow result upload); `headersTimeout` and `keepAliveTimeout` keep Node's defaults. |
| `repo.ts`, `git.ts` | All git commands for one clone: changes, diff, pull procedure (its dirty check and stash leave `<root>/Input` out), commit, push, conflict sides and resolution; hardened `runGit`. `Repo.stageSymlink` / `stagedAsSymlink` stage a path as a symlink (mode 120000) without committing. |
| `search.ts` | The vault search (#138): `SearchIndex` per vault root, text analysis (`fold`, `detectLanguage`, `wordTerms`), ranking and hit lines ([Vault search](#vault-search)). |
| `files.ts`, `paths.ts` | Tree listing, versions (content hash), `filesMentioning` (ripgrep, for the move's link scan), the note graph (`graph`: notes + links via the shared `noteLinks`, for `GET /vaults/:id/graph`); path normalization and symlink-safe resolution. `Vaults.rawFile` resolves a raw-file path with the same rules; `Vaults.upload` writes uploads ([Uploads](#uploads)). |
| `bases.ts` | Bases query tables (#91): `parseBase` (YAML via `yaml`, core schema; v1 subset, `BaseError` `base-invalid` / `base-unsupported` → 422), a Pratt parser and evaluator for filter expressions (unsupported names refused before any file is read), and the file index: per vault root, every file's size, times, frontmatter, tags and link references as written (`linkRefs`; not the full text), re-read only when size or mtime changed (stat per query, no watcher coupling); links are resolved per query with the shared basename index of `resolveWikilink` (one bucket per link, not a scan of every path). `forgetBaseIndex(root)` drops a root's index when the vault is removed or its root, branch or repo changes (and when a watcher starts). `queryBase` filters, sorts (empty last, path as tie-break), caps at `limit` / 500 rows and serializes cells (`BaseCell`: dates as `YYYY-MM-DD[ HH:mm]`, `file.name` / `basename` / `path` as links). `POST /vaults/:id/base` `{ source }`. |
| `lock.ts` | Per-vault reader/writer lock with writer preference (shared: `save`, `turn`, and `fetch` and `refresh` through `tryShared`, which never queues; exclusive: every other git operation). `fetch` and `refresh` are quiet: they don't change `busy`. `holds(label)` tells whether a shared holder with that label exists. |
| `watcher.ts` | chokidar on the vault root, 300 ms debounce → `files-changed` + status events; every raw event also goes undebounced to the search index (`onEvent`). |
| `chat.ts` | Chats and turns: per-vault queue (one running turn; up to 10 prompts of a chat wait, each with an id, #155), pull before each turn, stream fan-out, abort, adoption of busy sessions after a restart. Also the command list (`commands()`, name-clash rule, skill stamp and refresh) and command turns (`instructionsFor`) ([Commands](#commands)). |
| `harness/opencode.ts`, `harness/map.ts` | The only code that knows opencode: an ACP-shaped `Harness` interface (`commands(dir)`, `refresh(dir)` next to prompt, models and events) and the mapping of opencode events to app events. Tool names live only here: `WRITE_TOOLS` set `ToolCall.writes`, `OPEN_TOOLS` (`open_note`) set `ToolCall.opens`; `ToolCall.suggestion` is set from the `prompt` of `suggest_next`; `ToolCall.url` is set for `webfetch`, `open_url` and `save_url` (also in `WRITE_TOOLS`, so a download is a changed file and gets an AI stamp). `move_to_sources` is in `WRITE_TOOLS` too: its chip path is `Sources/<name>`, `writtenPaths` reports every moved file's old and new path from the tool's `metadata.files`. Context usage (#140): `mapMessageInfo` sets an assistant message's `context.used` from its `tokens` (`total`, else input + output + reasoning + cache read + write; 0 → none), and the harness adds `context.limit` by the message's model on chat load and stream, from `ModelLimits`. See [Chat context usage](#chat-context-usage). Error origin (#169): an assistant message's error carries `errorOrigin` (`ErrorOrigin`: `{ kind: 'tool', tool }` or `{ kind: 'model' }`; none for `MessageAbortedError`), and the stream's `error` event `origin` (none for the backend's own errors). On a load `mapMessages` takes the message's tool that was still running when it failed (opencode marks those `error` "Tool execution aborted" with `metadata.interrupted`); live, where a message comes without parts, `ErrorOrigins` (one per event subscription) follows each session's running tool calls: opencode publishes `session.error` while the tool still runs, sets the session `idle`, then aborts the tool, sends the message with its error and sets `idle` again; an aborted tool's part update re-enters it after the first idle, the last idle frees the session. The web's `errorLine()` (`lib/chat.ts`) makes the pill text. Usage (#150): `Harness.usageSessions(dir)` lists every session of a directory, children included and without a limit (`usageSessions()` in `map.ts`), and `Harness.sessionUsage(dir, id)` maps a session's messages to `UsageRow`s (`usageRows()`: per assistant message `created`, `provider/model`, tokens, cost, `completed`; metadata only). |
| `usage.ts` | `UsageService.report(days)` (#150): lists each vault's sessions through a `UsageSource`, reads a session's rows only when its `time.updated` moved (cache per directory and session, concurrency 4, unfinished replies not cached), sums by day (process timezone), model and vault; a failing vault is logged and left out. See [Admin mode](#admin-mode). |
| `metrics.ts` | `MetricsSampler` (#150): samples CPU, memory, load, the vaults and config disks and opencode's health every 30 s, keeps 7 days in memory and in `<CONFIG_DIR>/metrics.jsonl`, `report(range)` averages into ≤ 240 points. Host readers and the clock are injectable. See [Admin mode](#admin-mode). |
| `harness/context-cache.ts` | Pure (#140): `lastEntries(sessions, cache, fetchLast)` gives each listed chat its `lastEntryAt` (newest message, any role) and `context` (last assistant message), fetching `session.messages(limit 4)` only for sessions whose `time.updated` moved (concurrency 4, a failed fetch retried next list), and sorts by `lastEntryAt ?? updatedAt`, newest first; `ModelLimits` caches each model's `limit.context` from `models()` and reloads on an unknown model. |
| `browser-calls.ts` | `BrowserCalls` (on `Vaults`, #151): the pending browser calls of every vault, the answer files and the deadline ([Browser tools and local time](#browser-tools-and-local-time)). `chat.ts` opens a call when a mapped browser tool part is `running` and closes it when the part leaves `running`, and `closeVault`s at the turn's end. |
| `harness/local-time.ts` | Pure (#151): `localTimeLine(now, timeZone?, locale?)`, the hidden line with the user's local time that `promptParts` adds to every prompt. |
| `harness/command.ts` | Pure: `parseCommand`, `expandCommand`, `withoutBaseDir`, `commandInstructions`. |
| `commit-message.ts` | Proposes commit messages with a throwaway, tool-less session; marked as a running proposal so a skill refresh doesn't cut it off. |
| `chat-title.ts` | `ChatTitles` (#148): the title after turn 2 and the drift check every 10 turns, through a throwaway, tool-less session of the `chat-title` agent; keeps and answers the title suggestions ([Chat titles](#chat-titles)). |
| `vision-model.ts` | `syncVisionModel(vaultsDir, settings)`: writes or removes `<vaults>/.vision.json`, the admin's vision model for the `look_at_image` tool ([Chat titles](#chat-titles)). |
| `config-store.ts` | Atomic, serialized writes to `/config/config.json`; also holds the GitHub token set in the app. Knows the deployment's defaults (`defaults`: model, title model, vision model, web access, threshold) and stores the three models only as `modelOverride`, `titleModelOverride` and `visionModelOverride` while they differ from them ([Settings](#settings)); holds the per-chat `titleSuggestions`. |

### opencode (`deploy/opencode`)

The pinned stock image (`deploy/opencode/Dockerfile`) plus a **managed config** at `/etc/opencode/opencode.json` (merged last, so a vault can't override it; it holds policy only, no provider):
agents `vault` (edits allowed except `.git` and harness config), `vault-readonly` (default; used during conflicts) and
`commit-message` and `chat-title` (#148; no tools: `"*": "deny"`, prompt "You name chats. …": only the title, at most 8 words, in the conversation's language, no quotes, no trailing period); `bash`, `webfetch`, `websearch`, `save_url`, `move_to_sources`, `task`, `question` and `external_directory` denied
(`save_url` and `move_to_sources` are allowed for `vault` only; `websearch`, `webfetch` and `save_url` are switched on per turn by the backend, see [Web access](#web-access); `move_to_sources` is not in that map, the agent alone decides);
reading `*.env` denied; snapshots, sharing and auto-update off. The image sets `OPENCODE_ENABLE_EXA=true` and
`OPENCODE_WEBSEARCH_PROVIDER=exa`; its entrypoint exports the `opencode_password` secret as
`OPENCODE_SERVER_PASSWORD` (HTTP Basic on every route, health included). The image sets `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`:
opencode then reads a vault's skills from `.agents/skills/` only, and still loads `CLAUDE.md` and `AGENTS.md` (`AGENTS.md`
first). The image has no git binary, so opencode can't detect
a worktree and stays confined to the session directory (the vault root).

**Model and provider** come from the environment's settings, through the rendered `opencode.env` (`env_file`):
`OPENCODE_MODEL` (the default model), the gateway's API key under its provider's variable (`OPENROUTER_API_KEY`, …)
and `OPENCODE_CONFIG_CONTENT`, the gateway's provider config as JSON (for OpenRouter the model's zero-data-retention
routing; an `openai-compatible` gateway would carry its base URL and model limits). opencode merges its configs in
this order, later wins:

```mermaid
flowchart LR
  V["vault's own opencode.json<br/>(project config)"] --> C["OPENCODE_CONFIG_CONTENT<br/>providers from deploy/settings/"]
  C --> M["/etc/opencode/opencode.json<br/>managed: agents, permissions"]
```

So a vault can't switch off the zero-data-retention routing or point the gateway elsewhere. An `OPENCODE_CONFIG`
file would be merged *before* the project config, which is why the providers don't travel that way (a vault's
`zdr: false` won in the check that found it).

The global config dir (`/opt/opencode-config/opencode/`) holds everything the image adds: `tools/` (`open_note`, `current_page`, `open_url`, `suggest_next`, `save_url`, `move_to_sources`, `look_at_image`, `user_location`),
`plugins/` (`known-url`, `md-lint`), `lib/` (helpers) and `skills/` (the **app skills**, today `research`). The bake step
waits for the eight tools in the tool ids and for both plugins' `ready` log lines before it makes the dir read-only.

**Custom tool `current_page`** (`deploy/opencode/tools/current_page.ts`, helper `deploy/opencode/lib/open-page.ts`): tells the model which
file the user has open (#143). The web app sends `openPage { path, mode, unsaved }` in the prompt body (none when no file is open); the backend
validates it (`normalizeRel`) and, when it accepts the prompt, writes `<vaults>/.open-page/<chatId>.json` (`src/open-page.ts`, atomic; the
dir sits next to the clones, outside every git clone, like `.preflight`; a prompt without `openPage` deletes the file, deleting the chat or its vault too). The path is a literal: the volume mounts at `/vaults` in the opencode container, the path `OPENCODE_VAULTS_DIR` names.
The tool reads `/vaults/.open-page/<context.sessionID>.json` (session id = chat id), re-checks the path with `resolveNote` and answers
"The user has `<path>` open (Write mode)." (plus an unsaved-edits hint), "No page is open …", "… no longer exists in the vault", or, for a path in a dot folder (`.agents`, which `resolveNote` refuses but `read` reaches), "… open, in a dot folder that this tool does not check: read it by that path". The model then
uses `read`. A tool rather than prompt injection: no changing line in every prompt, and the model asks only when the user means "this note". The
call shows as a plain chip; `harness/map.ts` is unchanged. Allowed for `vault` and `vault-readonly`.

**Custom tool `user_location`** (`deploy/opencode/tools/user_location.ts`, helper `deploy/opencode/lib/browser-call.ts`, #151): the one **browser tool**. No arguments; it waits up to 90 s for an answer file `/vaults/.browser-calls/<fileKey(session)>/<fileKey(call)>.json` that the backend writes when the user's browser has answered, and returns the position as text or one of the refusals. Allowed for `vault` and `vault-readonly`. The channel is in [Browser tools and local time](#browser-tools-and-local-time).

**Custom tool `open_note`** (`deploy/opencode/tools/open_note.ts`, path check in `deploy/opencode/lib/resolve-note.ts`):
checks that `path` resolves inside `context.directory`, exists, is a file and has no dot segment, then returns
`opened <path>`; it reads no content and opens nothing itself — the web app reacts to the completed tool part. It is
loaded from a global config dir that comes only from the image (`XDG_CONFIG_HOME=/opt/opencode-config`), allowed
explicitly for `vault` and `vault-readonly`. opencode writes `package.json` etc. into every config dir and installs
`@opencode-ai/plugin` there on startup, so the Dockerfile pre-bakes the dir with one throwaway `opencode serve`
(each poll bounded by a 2 s `wget` timeout; on failure the build prints opencode's log), then makes it root-owned and
read-only; at runtime it loads offline. Helpers can't live in `tools/` (every export there becomes a tool).

```mermaid
sequenceDiagram
  participant O as opencode (open_note)
  participant H as backend harness/map.ts
  participant C as backend chat.ts
  participant S as web useChat (ChatPane)
  participant A as web store openNote
  O->>O: resolve path in the vault root; missing / outside → tool error
  O-->>H: tool part completed (input.path)
  H->>C: part {call: {path, opens: true, writes: false}}
  C-->>S: NDJSON part event
  S->>S: open tracker: unseen + completed?
  S->>A: wide: now · phone / tablet: on idle · editing: toast instead
```

**Custom tool `open_url`** (`deploy/opencode/tools/open_url.ts`, check in `deploy/opencode/lib/offer-url.ts`): args `{ url }`;
refuses anything but `http:`/`https:` ("Only http(s) pages can be opened"), then returns `offered <url>`. It fetches
nothing and needs no Web access (the server makes no request). Baked like `open_note`, allowed for `vault` and
`vault-readonly` (`commit-message` keeps `"*": "deny"`). The web app turns the completed call into an Open chip ([Link
offers](#link-offers)).

**Custom tool `look_at_image`** (`deploy/opencode/tools/look_at_image.ts`, logic in `deploy/opencode/lib/look-at-image.ts`, #146): `{ path, question? }`. `resolveImage` reuses `resolveNote` (inside the vault, no dot segments), allows png, jpg, jpeg, gif, webp up to 10 MB; `buildRequest` makes an OpenAI chat request (question plus the image as data URL, `stream: false`, the model's request options merged in); `visionConfig(env, file)` picks the model and options per call (#148): the `model` of `/vaults/.vision.json` (written by the backend for an admin override, [Chat titles](#chat-titles)) when the file exists and parses, else `VISION_MODEL`; options = `VISION_MODEL_OPTIONS[model]` when the map has it, else `VISION_REQUEST_OPTIONS` (the default model's) when the model is `VISION_MODEL`, else none; `describeImage` POSTs it to `VISION_BASE_URL/chat/completions` through the egress proxy (Bun's `fetch` `proxy`), 120 s timeout, `Bearer VISION_API_KEY` when set, and returns the first choice's text cut at 8000 characters. Errors (`image recognition is not configured`, HTTP status with a short body, never the key) reach the model as tool errors. Allowed for `vault` and `vault-readonly`, not in `WRITE_TOOLS`; an attached file reaches a text-only model as a file part named by its vault path, which the tool description points at.

**Custom tool `suggest_next`** (`deploy/opencode/tools/suggest_next.ts`, check in `deploy/opencode/lib/suggestion.ts`, import-free):
args `{ prompt }`; collapses whitespace, refuses an empty prompt and one over 160 characters (an error the model can
retry from), returns `suggested: <prompt>`. Its description is the only standing instruction: at most once per turn, as
the last action, one concise next step in the user's language, skipped when there is none. Baked like `open_note`,
allowed for `vault` and `vault-readonly`, not in `WRITE_TOOLS`. The web app derives the ghost text from history
(`nextSuggestion(messages, turn)` in `lib/chat.ts`: the latest completed call after the last user message, `idle` only),
`turns()` drops the call from the chips, and the composer (`ChatPane`, `Ghost` in `components/Suggestion.tsx`) shows it
over the empty textarea with an accept button ("Tab" on `(hover: hover)`, "Tap to use" otherwise); Tab (`isAcceptKey`) or
a tap puts it into the composer and sends nothing.

**Custom tool `save_url`** (`deploy/opencode/tools/save_url.ts`, logic in `deploy/opencode/lib/save-url.ts`): args `{ url, filePath, note? }`.
Downloads one http(s) URL into the vault as a **new** media file or PDF (`SAVE_TYPES`: the media table without SVG, plus
`pdf`; a test keeps it in sync with `packages/shared`) and returns `saved <path> (<size>). …`. With `note` (an existing `.md`/`.markdown` file inside the vault, same confinement as
`filePath`, checked before the download, so a refusal saves nothing) the tool also appends `![[<path>]]` on its own line to
that note (newline first if it lacks one; nothing else is rewritten; no md-lint, a single embed line can't break it) and
reports the note in `metadata.files`, so `writtenPaths` marks it changed by the AI too. Without `note` the result tells the AI
to call `edit` on the note itself. One call does both for a small model (#142). A file name
with a character Obsidian forbids (`: * " \ < > | ?`) is refused with a hint, so a model can't glue the note's name into it. It never overwrites (`wx`: "already exists: …; choose another name"),
creates missing folders, and refuses a path outside the vault (symlinks resolved), a dot-segment, a non-http(s) URL, an HTTP
error, a Content-Type that doesn't fit the extension (an HTML page saved as `.png`; `application/octet-stream` passes) and
a file over 50 MB (the upload cap; the partial file is removed). Timeout 120 s. The download always goes through the egress
proxy, passed explicitly as Bun's `fetch` `proxy` option from `HTTP(S)_PROXY`; without a proxy env the tool refuses. Bun
still fetches `NO_PROXY` hosts directly, so redirects are followed by hand (at most 5) and every hop to a `NO_PROXY` host is
refused ("internal host refused") ("No egress proxy configured"). Baked like `open_note`; allowed for `vault` only, not `vault-readonly`.

**Custom tool `move_to_sources`** (`deploy/opencode/tools/move_to_sources.ts`, logic in
`deploy/opencode/lib/move-to-sources.ts`, import-free so the backend tests load it): args `{ name }`, one input item
folder name. Moves `Input/<name>` to `Sources/<name>` with one `rename` (atomic, no copy of media) and returns `Moved to
Sources/<name>` plus `metadata.files: [{ filePath: "Input/<name>/<f>", movePath: "Sources/<name>/<f>" }]` for every
moved file (the shape `apply_patch` reports; opencode passes a custom tool's metadata into the tool part). Refuses a
name that is empty, `.`/`..`, hidden or has a `/` or `\`; `Input`, `Input/<name>` or `Sources` that is a symlink (`lstat`)
or not a directory; an item whose `index.md` frontmatter still has `unresolved_links` (a small reader for that one key:
inline value or block list, quoted key, blank and comment lines skipped); and an existing target, which it claims first
with a non-recursive `mkdir` so `rename` only ever replaces that empty folder ("Sources/<name> exists: rename or merge by
hand"). Creates `Sources/` if missing. Baked like `open_note`; allowed for `vault` only, so a read-only or conflict turn
can't move.

**Plugin `known-url`** (`deploy/opencode/plugins/known-url.ts`, pure decision in `deploy/opencode/lib/known-url.ts`,
baked into the same global config dir): a `tool.execute.before` hook for `webfetch`, `websearch`, `open_url` and `save_url`
(`GUARDED_TOOLS`). It loads the session's messages through opencode's plugin client (failing closed without them) and
throws what `guardWebCall(tool, args, messages, caps)` returns, or lets the call run on `null`. `guardWebCall`: for `webfetch`,
`open_url` and `save_url` it collects user text and completed tool outputs and refuses "URL not in this chat: paste it into the
chat first" unless the URL is known (`extractUrls`, `isKnownUrl`); for `webfetch`, `save_url` and `websearch` it counts the calls
after the last user message and refuses once the per-turn cap is reached (`capFromEnv`: `WEB_FETCH_CAP` /
`WEB_SEARCH_CAP` in `opencode.env`, rendered from `ai.web.fetch_cap` / `search_cap`, default 20; `webfetch` and `save_url` calls together count against the fetch cap). `save_url` is also in the
plugin's `WRITE_TOOLS`: a file it saved and the AI reads back is not a known source. `open_url` has no cap: the user taps each chip. Stateless, so it survives an opencode
restart.

**Plugin `md-lint`** (`deploy/opencode/plugins/md-lint.ts`, logic in `deploy/opencode/lib/md-lint.ts`, free of opencode
imports so the backend tests load it; #118): the **Markdown check**. A `tool.execute.after` hook for `edit`, `write`,
`multiedit`, `apply_patch` and `patch` (`LINTED_TOOLS`; not `save_url` or `move_to_sources`). `writtenFiles` takes the
written paths from `args.filePath` and a patch's `metadata.files[]` (`filePath`, `movePath`; the shapes `writtenPaths` in
`harness/map.ts` reads), keeps `.md`, and resolves them against the plugin's `directory`, which is the session's vault root.
For each file `appendReport` reads the **whole file**, runs `lintMarkdown` and appends `checkReport(path, findings)` to
`output.output`, the tool result the model gets. A missing file or a directory is skipped; any other error is logged
(`md-lint: <file>: …`). The check never fails a write.

```mermaid
sequenceDiagram
  participant M as model
  participant T as opencode write tool
  participant P as plugin md-lint
  participant V as vault file
  M->>T: write Wiki/people.md
  T->>V: write
  T->>P: tool.execute.after(tool, args, output)
  P->>V: read the whole file
  P-->>T: output += "Markdown problems in Wiki/people.md … Fix them now: - line 3 [table-wikilink-pipe] …"
  T-->>M: tool result incl. the report
  M->>T: edit (escape the pipe), checked the same way
```

`lintMarkdown(text)` first turns CRLF into LF and blanks what isn't rendered prose to spaces, keeping newlines and
columns: frontmatter, HTML comments, fenced code (a closing fence has the same character, at least the same length and
no info string; the rules repeat `codeRanges` in `packages/shared/src/relink.ts`) and one-line code spans. Two rules:

- `wikilink-wrapped`: `[[`, one to three line breaks with no `[` or `]` in between, then `]]`. A blank line in between
  (also `>` only) is a paragraph break, not a finding. Fix: put the whole link on one line.
- `table-wikilink-pipe`: in a table (a run of lines starting with `|`, also after a `>` prefix, with a delimiter row),
  a `[[…]]` whose alias `|` isn't escaped. Fix: `\|` for every such bar.

Known limits, no finding: tables without a leading `|`, code spans over several lines, indented code blocks, `[[…]]` in
clipped non-Markdown. A small model may ignore the report: the 3B dev model does, and then the file stays as it wrote it.

The app reads the table-safe `[[target\|alias]]` like `[[target|alias]]`: `parseWikilink` (shared, used by backlinks,
the graph and Read mode), the rename rewrite (`rewriteLinks` keeps the `\|`), `wikiEmbed` (`apps/web/src/lib/media.ts`)
and the editor's live preview (`apps/web/src/lib/cm.ts`). In a GFM table, `marked` unescapes `\|` before the wikilink
tokenizer runs.

Decisions (spec change `md-lint-on-write`, #118):

| Decision | Alternatives considered | Why |
|---|---|---|
| Report after the write, to the model | refuse a broken `write` (built, measured, dropped); silent auto-fix; a lint tool the model may call; a rule in the agent prompt | Deterministic on every write; the model fixes it with full context. A refused `write` left no file at all with a model that doesn't retry; an auto-fix makes the model's view of the file stale; a tool can be skipped; a prompt rule costs tokens every turn. |
| Whole-file check | only the lines the write changed | Old breaks heal when the AI touches a page; patch tools give no clean before/after. Clipped `Sources/` has no findings today. |
| Two own rules, no linter | markdownlint (MD056 + custom rules), rumdl, remark-lint, Obsidian Linter | As of 2026-10 none knows Obsidian wikilinks well enough: markdownlint flags the table case only as "too many cells" and has no rule for wrapped links; the custom rules would be the same regexes, plus ~9 MB in the image. |
| Invisible to the user | a badge on the tool chip | The correcting edit already shows as one more chip. |

### Ingest service (`deploy/ingest`)

The compose service `ingest` runs the existing ingest-email tool (Python, ~4.6k lines with resolvers, OCR, Instagram
pacing and retry state) in its own container instead of porting it: not in the backend image (it holds the GitHub and
bearer tokens while this parses untrusted mail and web pages), not in opencode's (bash is denied there on purpose, and
fetching is not AI work). Deterministic, no LLM, never commits.

- **Image** (`deploy/ingest/Dockerfile`, the fifth release image `ghcr.io/tillg/karpathy.app-ingest`): a build stage
  installs ingest-email and instascraper (at its own tag, `v1.1.0`, newer than ingest-email's `[instagram]` extra pins:
  it has the code callback) into a venv, so git stays out of the runtime image; the runtime stage is
  `python:3.13-slim` plus `tesseract-ocr` (`deu`, `eng`), `poppler-utils`, `ffmpeg` and the static `gog` binary (pinned
  release, sha256 per arch). ingest-email is a **private** repo pinned to the commit in `deploy/ingest/ingest-email.ref`;
  its source comes in as the **named build context `ingest_email`**, so the build itself needs no credentials:
  `deploy/ingest/fetch-source.sh` clones it into `tmp/ingest_email-src` with the developer's own git access (`just dev
  up`, `just prodtest`, the shell tests), CI and the release workflow check it out with a read-only deploy key
  ([deployment.md](deployment.md#releases)). A `test` stage adds pytest and `test_server.py`; it is never published.
  Runs as `APP_UID`, `init: true`.
- **Loop** (`deploy/ingest/run.sh`, the container's command): every `INGEST_LOOP_S` (60 s) it renders ingest-email's own
  config from `/etc/ingest/config.json` and runs `ingest-email resolve <profile>` per profile, every `INGEST_FETCH_S`
  (900 s) first `ingest-email ingest <profile>`. Per profile the render maps `vault` (+ `root`) to
  `target_dir=/vaults/<id>[/<root>]/Input` and `archive_dirs=[…/Sources]`, `label` to the four Gmail labels
  (`<label>`, `/processed`, `/failed`, `/rejected`), and passes `account`, `allowed_senders` and `settings` on; a vault
  that isn't cloned is skipped with a log line, `Input/` is created in a cloned one. Profiles run in sequence, one
  process per container; ingest-email's per-profile lock stays (against a manual `docker compose exec ingest
  ingest-email …`). At start it removes leftover `Input/.tmp-*` folders. It exports the `gog_keyring_password` secret
  as `GOG_KEYRING_PASSWORD`, starts `server.py` and restarts it whenever it died.
- **Health:** the loop touches the last-run file `/state/last-run` before and after every ingest-email call (a long
  resolve with Instagram pacing is not a stuck loop); the healthcheck fails when it is older than 20 min. With no
  profiles the loop idles and the file stays fresh.
- **Why a poll loop, not a watcher:** "within a minute" is enough, `resolve` is a cheap scan of `Input/*/index.md`, and
  inotify on a bind or volume mount adds a failure mode. In local mode Instagram pacing (1–3 min per post,
  08:00–23:00, daily caps) stays inside ingest-email and only delays the next round; it never holds an app lock. In
  worker mode the pacing runs on the worker, and the resolver only reads the dropbox.
- **Endpoint** (`deploy/ingest/server.py`, stdlib `ThreadingHTTPServer` on `:8090`, HTTP/1.1 keep-alive, `internal`
  network only): the Instagram connection and the Instagram workers' job API ([Ingest](#ingest)). Every request needs
  `Authorization: Bearer <ingest_token>` (compose secret, compared with `hmac.compare_digest`); only request lines are
  logged, never bodies. The mode comes from `INGEST_INSTAGRAM_SOURCE` (`local` default | `worker`), rendered from
  `ingest.defaults.instagram_source`; `run.sh` sets every profile's `instagram_results_dir` to
  `$INGEST_STATE/instagram/results`, and the profile settings carry `instagram_source` to ingest-email.
- **Compose:** `user` = the app uid, `cap_drop: [ALL]`, `no-new-privileges`, bounded logs; network `internal` only
  with `HTTP(S)_PROXY=http://egress:3128` (httpx, `gog` and instagrapi all honour it); `GOG_HOME=/state/gog`,
  `GOG_KEYRING_BACKEND=file`, `HOME=/state/home` (instascraper's session and activity ledger),
  `INGEST_INSTAGRAM_SOURCE`; secrets `gog_keyring_password` and `ingest_token` (never `ingest_worker_token`: the
  service doesn't see the worker token); volume `ingest-state` at `/state` (worker mode adds `/state/instagram/`,
  mode 0700: `results/`, `incoming/`, `workers.json`); `ingest.json` (rendered from
  `deploy/settings/`) bind-mounted read-only at `/etc/ingest/config.json` (`create_host_path: false`); depends on a
  healthy `egress`. The base `compose.yml` mounts no vault: a target adds one `Input/` (rw) and `Sources/` (ro) bind
  mount per profile vault in `compose.target.yml`; dev and prodtest mount the whole `vaults` volume.

### Instagram worker (`tools/instagram-worker`)

Runs on the user's machine, not in the stack (#168, [ADR 0006](../../docs/adr/0006-instagram-scraped-by-a-worker.md)):
Instagram blocks the server's data-centre IP, a home IP works. It talks to the server only as an HTTPS client, so it
needs Tailscale where prod's proxy listens on the tailnet only. Setup guide: `docs/instagram-worker.md`.

- **Package:** `pyproject.toml`, src layout, package `karpathy_instagram_worker`, console script
  `karpathy-instagram-worker`, `requires-python >= 3.11`. Its only dependency is
  `instascraper @ git+https://github.com/tillg/instascraper@v1.1.0`, the ingest image's `INSTASCRAPER_REF`; HTTP is
  the stdlib. Installed with `pipx install "git+https://github.com/tillg/karpathy.app@<tag>#subdirectory=tools/instagram-worker"`.
- **Config** `~/.config/karpathy-instagram-worker/config.toml` (atomic, mode 0600; `KARPATHY_WORKER_CONFIG`
  overrides the path): `server` (`https://`, `http://` only for localhost), `token`, `name` (default: the short host
  name, `^[A-Za-z0-9._-]{1,64}$`), `poll_interval_s` (60, at least 5).
- **Modules:** `config.py`, `client.py` (the job API over `urllib`; 204 → no job, 409 → `NotWorkerMode`, 401 →
  `TokenRejected`, unreachable or 5xx → retried after 1, 2, 5 min, then `ServerUnavailable`), `upload.py`, `scrape.py`
  (instascraper calls and error mapping), `loop.py` (`Worker.step()` and the loop), `service.py` (launchd / systemd,
  `templates/`), `cli.py` (argparse).
- **Commands:** `configure` (asks for what is missing, the token with `getpass`; one heartbeat checks it and a
  rejected token isn't saved), `login` (instascraper's `login_interactive_free` with the password from `getpass` and
  the 2FA/challenge code read from stdin, so it works over SSH; `--browser <name>` (safari, chrome, firefox, …) takes
  a browser's session instead; remembers `IG_USERNAME` in instascraper's own `~/.config/instascraper/.env`), `doctor` (Python,
  instascraper, config 0600, server and token, session file, `ffmpeg` as a warning only, the service; exit 1 if a
  required check fails), `once` (one step), `run` (the loop until SIGTERM), `service install|uninstall|status`,
  `version`.
- **One step** (sleeps and clocks injected for tests; a step returns how long to wait, `run` waits on an event SIGTERM
  sets, so the job in progress always finishes):
  1. No remembered account or no session file → heartbeat `needs-login`, 10 min, no claim.
  2. Open the account's `ActivityLedger(activity_path(user), window_seconds=…)` (busy → `resting`) and build one
     `Humanizer(BehaviorProfile(), ledger=…)`, as instascraper's CLI does per run. `gate("post")`: `STOP` → `night`
     (outside the active hours) or `resting` (a day ceiling), 30 min; `WAIT` → `resting` for the gate's seconds. No
     claim either way.
  3. Claim. 204 → `idle`, `poll_interval_s`; 409 → `idle` with "the server is in local mode".
  4. Heartbeat `scraping`; `get_client` with stdin on `/dev/null` (it then ends with `SystemExit` instead of prompting:
     a worker never logs in by itself), `scrape`, `write_result` into a temp dir; upload; then wait
     `humanizer.sample_delay("post")`.
- **Error mapping** (like instascraper's `cli.py`):

  | Raised | Worker does | State |
  |---|---|---|
  | `MediaNotFound`, `ClientNotFoundError`, a shortcode mismatch | `failure {permanent: true}` | `idle` |
  | `LoginRequired`, `ClientLoginRequired`, `ChallengeRequired` | `release`, 10 min | `needs-login` |
  | `SystemExit` from `get_client` (any failed session check: network error, 429, expired session) | `release`, 30 min; the 3rd in a row (a working `get_client` resets the count) → as `needs-login` | `rate-limited` ("… (n of 3 before asking for a login)"), then `needs-login` |
  | `PleaseWaitFewMinutes`, `ClientThrottledError`, HTTP 429 | `release`, 30 min | `rate-limited` |
  | upload answered 413 or 422, or refused locally | `failure {permanent: true, reason: <message>}` | `idle` |
  | upload answered `404 unknown-job` | nothing (nobody wants the post any more) | `idle` |
  | upload answered another 4xx | `failure {permanent: false, reason: "upload refused: …"}` | `error` |
  | any other exception | `failure {permanent: false, reason: "<Type>: <message>"[:200]}` | `error` |
  | 401 | the loop stops, exit 1 ("worker token rejected: run configure"); the service manager restarts it | — |

  A heartbeat, failure or release call that fails is logged and never ends the step: the lease lapses instead.
- **Upload:** a gzip tarball of the regular files directly inside `<shortcode>/` (flat, no directories, no links) in a
  temp file, then a streamed `PUT` with `Content-Type: application/gzip` and `Content-Length` in 1 MiB chunks; over
  40 files or 500 MB it is refused locally, so it never sends what the server would refuse.
- **Service:** macOS LaunchAgent `~/Library/LaunchAgents/app.karpathy.instagram-worker.plist` (the absolute command +
  `run`; `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 60, `ExitTimeOut` 300, `ProcessType` Background; log
  `~/Library/Logs/karpathy-instagram-worker/worker.log`, not rotated), loaded with `launchctl bootstrap gui/<uid>`,
  removed with `bootout`; it runs while the user is logged in. Linux: systemd user unit
  `~/.config/systemd/user/karpathy-instagram-worker.service` (`ExecStart=<abs> run`, `Restart=always`,
  `RestartSec=60`, `TimeoutStopSec=300`), `daemon-reload` + `enable --now`, logs in the journal; a headless box needs
  `loginctl enable-linger`. Both carry a non-default `KARPATHY_WORKER_CONFIG` into the service. `status` shows the
  state and the last 20 log lines.

### Egress proxy (`deploy/egress`)

Squid 6 in an own Alpine image (base pinned by digest; the fourth release image), on networks `internal` and
`egress`. Used by opencode and by the ingest service. `squid.conf` has one `dst` ACL of internal ranges (loopback, RFC 1918, link-local, CGNAT/tailnet, ULA,
multicast, …) that is denied, then allows everything else; Squid checks after DNS resolution on every request, so
each redirect hop is re-checked. opencode gets `HTTP_PROXY`/`HTTPS_PROXY=http://egress:3128` and
`NO_PROXY=localhost,127.0.0.1,0.0.0.0` (its plugin client calls its own server directly; no override in dev or the backend tests). Gotcha: `::ffff:0:0/96` or `0.0.0.0/8` in the ACL make Squid read `0.0.0.0/0`, so they stay out.

### Proxy (`deploy/proxy`)

Serves the built PWA from `/srv` with SPA fallback, proxies `/api/*` to the backend unbuffered (`flush_interval -1`),
sets CSP and security headers (`img-src` and `media-src` allow `blob:` for media embeds; `frame-src` and
`object-src` stay closed; `Permissions-Policy: geolocation=(self)` keeps the location API to the app itself), and gets its certificate by DNS-01 (`TLS_MODE=dns`; GoDaddy, with a 90 s wait for
GoDaddy's nameservers) or from Caddy's internal CA (`TLS_MODE=internal`: dev and prodtest).
`DOMAIN`, `TLS_MODE` and `DNS_PROVIDER` come from the rendered `.env` (settings `proxy.domain`, `proxy.tls`,
`proxy.dns.provider`). A
plain-HTTP site on `127.0.0.1:8081` answers the container healthcheck.

## Communication

```mermaid
sequenceDiagram
  participant W as Web
  participant B as Backend
  participant O as opencode
  W->>B: POST /api/vaults/:id/chats/:chat/prompt
  B-->>W: 202 queued {id}
  W->>B: GET …/stream (NDJSON)
  B->>B: lock: exclusive pull, then shared "turn"
  B->>O: session.promptAsync(agent, model)
  O-->>B: SSE events (status, message, part, delta, file.edited)
  B-->>W: turn / message / part / text-delta events
  O-->>B: session idle
  B-->>W: turn idle (stream ends), or queued if more of the chat's prompts wait
  B->>B: release lock, files-changed via watcher
```

- **Queued prompts** (#155): `ChatService` keeps one FIFO queue per vault; each entry (`Turn`) has an id, its chat,
  text, attachments, client context and, when it was sent while its chat was busy, its `openPage` (written to the
  open-page file when its turn starts, so the running turn keeps reading its own page). `prompt()` no longer refuses a
  busy chat; it refuses an 11th waiting prompt of a chat (`409 queue-full`). `turnState` puts `running` before
  `queued`. The chat detail lists the chat's entries (`queued: QueuedPrompt[]`); the chat stream sends `{ type:
  'queue', queued, started? }` whenever they change (`started`: the id that just left the queue, sent before its
  `running`); a new chat stream starts with a `queue` snapshot after its `turn` event, since a prompt may have started
  since the client loaded the chat. A turn that ends while more of its chat's prompts wait emits `turn queued` instead of `idle` and keeps
  the chat's streams open, so the client follows the next turn without a reload. `DELETE
  /vaults/:id/chats/:chatId/queue/:promptId` (`unqueue`, `404 not-queued` once started) and `POST …/abort` (all of the
  chat's entries, then `harness.abort` of a running turn; a turn that left the queue but has not been sent to opencode
  yet is marked aborted, never sent, and returned too) return `ReturnedPrompt`s: text plus the files that still
  exist as composer chips (`version` from `versionOfFile`, `mime`, `size`). The web (`ChatPane`) chains its prompt
  POSTs so quick sends keep their order, shows a busy chat's prompt as a queued bubble at once (local id until the
  answer), an idle chat's as the pending bubble. After every accepted POST it follows the chat unless a chat stream is being
  read (the turn may have started after the last reload found the chat idle); a reload keeps the bubbles whose POST
  has not answered. Stop first waits for the POSTs on their way, so none lands on the stopped chat, and puts the
  texts back oldest first whether the idle event or Stop's answer comes first. `adoptStarted` turns a `started` entry
  into the pending bubble (a pending bubble still waiting for its POST's answer with the same text and files is that
  entry) and hands back one that never ran; `withReturned` merges returned prompts into the composer. A failed pull before a turn removes that turn by
  identity: one taken back while it waited for the lock leaves the queue's next prompt alone. A prompt is never sent into
  a busy opencode session (as Claude Code's mid-turn messages are): the per-vault lock, the pull before each turn and
  the idle-based turn end all rely on one prompt per turn, so the queue stays in the backend.

- **Request/response** JSON over `fetch`; **streams** as NDJSON over `fetch` (no WebSockets, no SSE to the browser):
  the vault event stream (`status`, `files-changed`, the agents move, `browser-call` / `browser-call-done`, `chat-title`; never ends)
  and the chat stream (ends when the turn is idle).
- **Browser calls** (#151): the backend asks the browser, the browser answers by `POST
  /api/vaults/:id/chats/:chatId/browser-calls/:callId` (bearer-guarded; `404` unknown or expired, `409` already
  answered, `400` invalid result). The question travels as the vault event `browser-call`; pending calls are replayed
  on connect. See [Browser tools and local time](#browser-tools-and-local-time).
- Turns outlive connections: a client reattaches to a running turn from any device.

## Incoming changes and the user's pull

```mermaid
flowchart LR
    subgraph Web
      GP[GitPill + PullLink<br/>· N incoming]
      CP[ChangesPanel<br/>N incoming changes · pull,<br/>incoming file list]
      NB[open-note bar<br/>Changed on GitHub · Pull]
      ST[store.tsx pull, pulling<br/>lib/incoming.ts incomingView]
      EV[useVaultEvents<br/>reconnect on visible / online]
    end
    subgraph Backend
      APP[app.ts<br/>GET /events, POST /pull]
      V[vaults.ts<br/>fetch schedule, fetchRemote, pull, status]
      LK[lock.ts tryShared 'fetch']
      RP[repo.ts<br/>fetchUpstream, incomingPaths]
    end
    GH[(GitHub)]
    EV -- "connect = subscribe" --> APP --> V
    V --> LK
    V --> RP -- "git fetch (token header)" --> GH
    V -- "status {incomingCount, incomingPaths}" --> APP --> EV --> ST --> GP & CP & NB
    GP & CP & NB -- tap --> ST -- "POST /vaults/:id/pull" --> APP
```

- **`VaultStatus`** gains `incomingCount` (files inside the root that `origin/<branch>` changed since the merge base
  with HEAD) and `incomingPaths` (the first `INCOMING_PATHS_MAX` = 200); `0`/`[]` while not `ready`. `status()` adds
  `repo.incomingPaths()` (`git diff --name-only -z HEAD...origin/<branch> -- <root>`, local refs only; without a
  merge base, after a replaced remote, the plain `HEAD` ↔ `origin/<branch>` diff) to its `Promise.all`. They go out on
  the existing `status` event and in the replies of `GET /status`, `POST /open` and `POST /pull`.
- **Background fetch** (`Vaults.fetchRemote`): `subscribe()` (the event-stream route is the only subscriber; unknown
  vault ids are refused) starts a per-vault `setInterval` (`fetchIntervalMs`, default 2 min) and one fetch per
  connect; the last unsubscribe, `close()` and `remove()` clear it. A running fetch is joined, not repeated. It takes
  `lock.tryShared('fetch')` (skipped when a git operation holds or waits), runs `repo.fetchUpstream()` (`git fetch -q
  --no-auto-maintenance --end-of-options origin <branch>`, 30 s timeout, the token as for every git command), sets or
  clears `pullError` (redacted), and emits a status only when `origin/<branch>` or `pullError` changed. It never
  rejects (a rejected promise from a timer would end the process). It runs in conflict too; the UI hides the count.
- **Git robustness:** on a timeout `runGit` sends SIGTERM and SIGKILL only after 2 s; `fetchUpstream` and the pull
  drop a stale `refs/remotes/origin/<branch>.lock` before fetching. A repo change clears `pullError` (`startClone`).
- **`POST /vaults/:id/pull`** → `Vaults.pull`: exclusive lock, `423` in conflict, then the same `pullUnlocked` as
  open, commit, push and turn; a conflict it causes shows in the returned `VaultStatus`, not as an HTTP error.
  `open()` first awaits a running background fetch, so its `tryExclusive` doesn't skip.
- **Web:** `lib/incoming.ts` `incomingView(status, pulling)` decides every incoming control (`show`, `disabled` while
  pulling or `busy !== 'none'`, label, title, `moreCount`), so the pill segment, the Changes banner, the open-note bar
  and the phone tab badge can't drift apart. The pill segment is a sibling button (`incoming-badge`) joined to the pill
  visually, so the pill's own click still opens Changes; pill and banners use `PullLink`. The store's `pull()` first
  saves the open note's pending draft (`leave()`), pulls once for a double tap, sets the status and toasts "Pulled N
  changes from GitHub" or "Couldn't reach GitHub". No new client timer: the event stream's reconnect on visibility and
  online already triggers a fetch.

## Web access

```mermaid
sequenceDiagram
  participant W as web Settings / ChatPane
  participant B as backend chat.ts
  participant O as opencode
  participant G as plugin known-url
  participant P as egress proxy
  participant X as Exa / public web
  W->>B: PATCH /settings {webAccess}
  W->>B: POST chat turn
  B->>O: promptAsync({agent, tools: {websearch, webfetch}}) + Basic auth
  O->>G: websearch {query} → cap check
  O->>P: CONNECT mcp.exa.ai
  P->>X: query
  X-->>O: results (URLs, page text)
  O->>G: webfetch {url}
  G->>O: GET /session/:id/message (direct, NO_PROXY)
  G-->>O: ok, or throw "URL not in this chat"
  O->>P: GET url (every redirect hop re-checked)
  P->>X: fetch
  X-->>O: page → Markdown / image
  O-->>B: tool parts
  B-->>W: NDJSON parts → web chips
```

- **Setting:** `Settings.webAccess`; its default is the environment's `ai.web.access` (`true`), and a value saved
  in the app wins (an old `config.json` without it reads the default through the defaults merge).
- **Per turn:** `chat.ts` sends `tools: { websearch: webAccess, webfetch: webAccess, save_url: webAccess && !readonly }` with every prompt of both chat
  agents, `false` included: opencode stores the map as the session's permission, replacing earlier rules and merged
  after the agent's. Any later per-turn rule must go into the same map.
- **Mapping:** `harness/map.ts` sets `ToolCall.query` (websearch `input.query`) and `ToolCall.url` (webfetch
  `input.url`); `writes`/`opens` stay false, no `path`. `save_url` is the exception: `writes` is true and `input.filePath` feeds
  `writtenPaths`, so a download shows in Changes and gets an AI stamp.
- **Chips:** `toolLabel(call)` (`lib/chat.ts`) → `searched the web: "<query>"` and `fetched <host><path>` (path cut at
  60 characters, full URL as tooltip). A completed fetch chip with an `http(s)` URL is a link (new tab, `noopener
  noreferrer`); a search chip is a label; a refused fetch shows the guard's message.

## Commands

A **command** is a skill the chat starts by name (`/name args`). The backend asks opencode for the vault's skills,
the web app offers them in a palette and as chips, and a command turn is an ordinary prompt with the skill's text added
as a hidden part.

```mermaid
sequenceDiagram
  participant W as web ChatPane
  participant B as backend chat.ts
  participant O as opencode
  W->>B: GET /vaults/:id/commands
  B->>O: GET /command + GET /skill (directory=/vaults/<id>)
  O-->>B: built-ins + skills (with template, location)
  B-->>W: [{name, description, source, replaces?}] (skills only)
  W->>B: POST /chats/:chatId/prompt {text: "/query what is RAG?"}
  B->>B: queue, pull, agents move, refresh opencode if a skill file changed
  B->>O: GET /command (find "query")
  B->>O: promptAsync(parts: [text "/query what is RAG?",<br/>text synthetic "…query instructions…"], tools)
  O-->>B: events (reads, reply)
  B-->>W: NDJSON as for any turn (synthetic part dropped by map.ts)
```

- **Route `GET /vaults/:id/commands`** → `ChatService.commands`: same checks as the chat routes (`409 not-ready`,
  `409 unsafe-config`, `503` when opencode is down). Returns `Command[]` (`@karpathy/shared`: `name`, `description`,
  `source: 'vault' | 'app'`, `replaces?: true`), vault skills first, each group A–Z; the template stays on the server.
- **`Harness.commands(dir)`** (`OpencodeHarness`): `command.list` plus `app.skills` for the same directory; keeps entries
  with `source === 'skill'` that aren't in `HIDDEN_COMMANDS` (`customize-opencode`; the built-ins `init` and `review` aren't
  skills). A skill is an **app skill** when its `location` lies under `/opt/opencode-config/`, else a **vault skill**.
- **Name clash.** opencode's pick between a vault skill and an image skill of the same name isn't stable, so
  `ChatService.vaultCommands` decides: the app skills' names come from the list for `/vaults` itself (which never holds vault
  skills), and for such a name the vault skill is read from `.agents/skills/<folder>/SKILL.md` (frontmatter `name`,
  `description`, body plus a base-directory line) and listed with `replaces: true`; command turns use that text too. The AI's
  own `skill` tool may still load either.
- **Skill refresh.** opencode caches a directory's skill list until the instance is disposed, so a skill that arrived with
  a pull would never show. `Harness.refresh(dir)` calls `instance.dispose` and returns once the directory's event
  subscriptions have reconnected (at most 5 s; the subscription treats the disposal as no outage). The **skill stamp** per
  vault is the sorted `path:mtime:size` of every `SKILL.md` under `.agents/skills/` in the vault root and each folder up to
  the clone root (in memory; the first check after a start counts as changed). When it differs from the last one seen,
  the backend refreshes, but never while a turn runs, because disposing ends the directory's sessions:
  - in `kick()`, inside the exclusive-lock section right after the pull and the agents move, unless a commit-message
    proposal runs for the vault (`Vaults.isProposing`; proposals take no lock);
  - in `GET /commands`, only while the vault is idle (`busy === 'none'`, no running or adopted turn, no proposal), holding the
    lock shared under the label `refresh` (`tryShared`, quiet) so no turn can start meanwhile. A pull or commit that is
    running is waited for first (at most 10 s, without queueing for the lock). Otherwise the cached list is returned.
  - `Vaults.open` waits up to 5 s for a `refresh` holder before its `tryExclusive` pull, so the pull of the same app load
    doesn't skip.
  - Known gap (#134): a skill folder *created* in the vault on the server (in the app or by the AI) isn't in opencode's
    list until the next pull; e2e therefore delivers its stub `ingest` skill by push and pull.
- **Command turns.** `harness/command.ts`: `parseCommand(text)` needs `/` and a name `[A-Za-z0-9][\w.:-]*` at the start, then
  whitespace or the end. `expandCommand(template, args)` follows opencode's rules (`$1…$N`, the highest taking the rest;
  `$ARGUMENTS`), but appends nothing when there is no placeholder, because the user's message already carries the arguments;
  `` !`…` `` and `@file` stay literal. `commandInstructions` prefixes a short header ("The user started the command
  `/<name>`…; paths to notes are relative to the vault root") and, for an app skill, `withoutBaseDir` drops the base-directory
  line, since that directory lies outside the vault. `PromptInput.instructions` becomes a second text part with
  `synthetic: true` (it reaches the model; `map.ts` drops synthetic parts from what the app shows, so the bubble is what the
  user typed). In `kick()`, only a name in the vault's list makes a command turn; anything else, `/etc/hosts is…`
  included, is a plain turn. A failing `commands()` fails the turn like a failing prompt. The queue still stores only
  `{ chatId, text }`, so a queued command survives a restart.
- **Never opencode's command endpoint** (`POST /session/:id/command`): it replaces `` !`cmd` `` in a skill with the output of
  `cmd`, run through a shell with no permission check, resolves `@file` references, and takes no per-turn `tools` map
  ([security.md](security.md#confining-the-ai), [ADR 0004](../../docs/adr/0004-commands-as-prompts-not-command-endpoint.md)).
- **Web: `lib/commands.ts`** (pure): `paletteQuery(text)` (the partial name while the text is `/` plus name characters, else
  `null`), `filterCommands` (case-insensitive; vault skills before app skills, prefix matches before other matches, each
  A–Z), `chipCommands(list, recent, 4)` (recent names still in the list first, then A–Z), `recentCommands` /
  `recordCommand` (localStorage `karpathy.recentCommands.<vaultId>`, at most 10 names, every access in `try/catch`).
  `ChatPane` › `Conversation` loads the list on mount, when the app reports an agents move or a `files-changed` event under
  `.agents/skills/` (`commandsNonce`, #134: a skill the AI or a save wrote outside a pull) and each time the palette opens; the list is optional: if the GET fails, palette and chips don't render and sending never waits for it.
  - **Palette:** a `listbox` above the composer while `paletteQuery(text) !== null`, grouped "This vault" and "karpathy.app",
    each row `/name`, a `vault`/`app` tag and the description; a `replaces` row adds "Replaces karpathy.app's /name; rename
    it in .agents/skills/ to get both." The textarea keeps focus (`aria-activedescendant`); ↑/↓, Enter or Tab pick, Escape
    closes, a row is picked on pointer-down. Picking sets the text to `/name ` and sends nothing.
  - **Chips:** up to four `/name` buttons in an empty chat (no messages, nothing pending); tooltip = description plus "from
    this vault" / "built into karpathy.app"; an app skill's chip has the app icon. A tap puts `/name ` in front of the
    composer's text and focuses it. `recordCommand` runs on every send that starts with a listed command.

### The `research` skill

`deploy/opencode/skills/research/SKILL.md`, copied to `/opt/opencode-config/opencode/skills/` by the `Dockerfile`: an app
skill listed in every vault unless the vault has a `research` skill of its own. It is self-contained (its base directory is
outside the vault, where `external_directory: deny` blocks reads) and the backend treats it like any command: no special
tools map, no special rule. What it tells the AI:

| Part | Instructions |
|---|---|
| Conventions | The vault's own instructions (`AGENTS.md`, `CLAUDE.md`, an ingest skill) decide folder, name and frontmatter of sources and pages; a source file is always a summary with short quotes. |
| Plan turn | Read the wiki index and topic pages; with web tools, scout at most 3 searches and 2 fetches and save nothing; without them, say Web access must be turned on. Write `Research/<YYYY-MM-DD>-<slug>.md` (topic, 3–6 sub-questions as `- [ ]`, what the wiki covers, budget of 8 sources per run turn) and end with "Edit the note if you like, then reply **go**." In conflict, put the plan in the reply. |
| Run turn | Re-read the plan note; per open sub-question at most 2 searches; skip URLs already in `Sources/`; fetch, save `Sources/<date>-<slug>.md` (`type: source`, `url`, `title`, `fetched`); at most 8 new sources; write or update cited wiki pages (`sources:` and `[[Sources/…]]`), update index and log, tick off the note. |
| Stop and ask | At a "limit reached" error or after 8 sources: list the open questions and ask for "continue". |
| Resume | `/research <plan note or matching topic>` skips the plan and runs on the note's open questions, in any chat. |

The plan step, the scouting budget and the stop are instructions to the model. The hard bounds are the per-turn web caps
and the user's reply before each block; no money or token cap exists.

## Link offers

```mermaid
sequenceDiagram
  participant AI
  participant G as plugin known-url
  participant T as tool open_url
  participant W as web ChatPane
  actor U as User
  AI->>G: open_url {url}
  G->>G: guardWebCall: known URL?
  alt unknown
    G-->>AI: error "URL not in this chat: paste it into the chat first"
  else known
    G->>T: run
    T-->>AI: "offered https://…"
    T-->>W: tool part (url) → Open chip
    U->>W: tap
    W->>U: new tab (user's browser, not the egress proxy)
  end
```

- **Mapping:** `map.ts` sets `ToolCall.url` for `open_url` as for `webfetch`; `opens` stays `false`, because `opens` drives the
  automatic note opening and a link offer never opens by itself (browsers block `window.open` without a tap, and the tap is the
  user's check of the host on the chip).
- **Web:** `toolLabel` → `open <host><path…>`; `toolHref` returns the URL of a completed `open_url` too. `ToolChip` renders it as
  an `<a target="_blank" rel="noopener noreferrer">` action chip (arrow icon, full URL as tooltip). A refused one is the usual error
  chip; tapping it shows "URL not in this chat: …".

## Browser tools and local time

Two independent parts (#151). **Local time** rides with the prompt: no tool, no round-trip. **Position** is a
**browser tool** (`user_location`) on a general browser-call channel. No new network path: opencode stays on the
internal network and talks to nobody new. The tool and the backend meet on the shared vaults volume, as
`current_page` does (`.open-page`); the backend reaches the browser over the vault event stream that is open whenever
the app shows the vault, and the browser answers with an ordinary authenticated request.

### Local time

- **Web:** every prompt body (plain and slash commands, same route) carries `timeZone`
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and `locale` (`navigator.language`), next to `tabId`.
- **Backend:** `promptBody` (`app.ts`) accepts `timeZone` (≤ 64) and `locale` (≤ 35), both optional, stored on the
  queued `Turn` like `openPage`. `localTimeLine` ignores a zone `Intl` doesn't accept and a locale
  `Intl.getCanonicalLocales` rejects (free text from the browser).
- **The line:** `harness/opencode.ts` → `promptParts` adds a `synthetic: true` text part (as command instructions
  already are; `map.ts` hides synthetic parts) when the turn is sent, **first**, before the user's text, so the request is
  what the model reads last: "User's local time: Thursday 2026-10-15 23:41, Europe/Berlin (UTC+02:00), locale de-DE.
  (Context from the app, not part of the user's message: use it for 'today', 'now' and dates in note names instead of
  the server date; do not mention it unless asked.)" Worded as context because the small dev model answered the plain
  line instead of the question. The time is taken when the turn runs, so a queued turn gets its own. The web keeps the
  pending bubble until the user message has a visible part (`userCount`), since the hidden part arrives first.
- **Fallback:** no `timeZone` (headless ingest runner, an old PWA) → the backend's own zone, i.e. the `timezone`
  setting (it already reaches the backend as `TZ`; Europe/Berlin on hetzner), read via `Intl`; locale omitted.

### Browser-call flow

```mermaid
sequenceDiagram
  participant W as Web (tab t1)
  participant B as Backend
  participant O as opencode
  participant T as tool user_location
  W->>B: POST …/prompt {text, tabId: t1, timeZone, locale}
  B->>O: promptAsync
  O->>T: execute(args, ctx)
  T->>T: poll .browser-calls/<session>/<ctx.callID>.json (250 ms)
  O-->>B: part tool user_location, state running
  B->>B: map.ts: browser tool → BrowserCalls.open(vault, chat, call, tool, input, t1)
  B-->>W: vault event browser-call {chatId, callId, tool, input, tabId: t1, deadline}
  W->>W: tabId == my tab id → navigator.geolocation.getCurrentPosition
  W->>B: POST …/chats/:chat/browser-calls/:call {ok: true, value} (or {ok: false, reason})
  B->>B: validate with the tool's schema, write answer file (atomic, once)
  B-->>W: vault event browser-call-done {callId}
  T->>T: answer file found → format text, delete file
  T-->>O: "The user is at 48.137154, 11.576124 (accuracy ±12 m, fix 3 s old)."
```

**Tool side (opencode image).**

- `deploy/opencode/lib/browser-call.ts` (import-free, so backend tests load it, like `open-page.ts`):
  `waitForAnswer(dir, sessionID, callID, { timeoutMs, abort })` polls
  `<dir>/<fileKey(sessionID)>/<fileKey(callID)>.json` every 250 ms, returns the parsed answer or `null` on timeout,
  stops on `abort`, deletes the file it read. The dir is the literal `/vaults/.browser-calls`. `fileKey` = base64url of
  the id, on both sides: any id a provider sends (`functions.user_location:0`) works and none becomes a path.
- The call id is `context.callID`: opencode 1.18.25 sets it from the model's tool call id, and the tool part the
  backend maps carries the same `callID`; a test keeps it true across upgrades.
- `tools/user_location.ts`: no arguments; waits 90 s (`BROWSER_CALL_TIMEOUT_MS`; the backend's `TIMEOUT_MS` is the
  same value, the images share no code). Texts: "The user is at 48.137154, 11.576124 (accuracy ±12 m, fix 3 s old).",
  "The user did not share their location.", "No position is available on the user's device.", "The user's browser
  cannot share a location.", "The user's device did not answer. Ask the user where they are if you need it." The
  description limits it to requests that depend on where the user is. It names its own chip with
  `context.metadata({ title })` (`locationTitle`: "used your location (±12 m)", "location not shared", "no location
  available", "no answer from your device"), because `ToolCall` carries no output.

**Backend.**

- `BROWSER_TOOLS` (`packages/shared`) is the one list of browser tools; `harness/map.ts` sets `ToolCall.browser = true`
  and `callId` for them. The web's handlers are a `Record<BrowserTool, …>`, so a tool without a handler fails the
  typecheck. Types `BrowserCall`, `BrowserCallResult` and `parseBrowserCallResult` (dependency-free) live in
  `packages/shared`.
- `BrowserCalls` (`browser-calls.ts`, on `Vaults`):
  - `open`: when a mapped part of a browser tool enters `running`; keeps `{ vaultId, chatId, callId, tool, input,
    tabId, deadline }` in memory and emits `browser-call`. Idempotent per vault + chat + call id (parts update several
    times; providers reuse ids like `call_0` across chats). `input` is `{}` today.
  - The tab is the vault's running turn's `tabId`, also when the tool runs in a subagent (`task`) session (a vault runs
    one turn at a time). An adopted turn (backend restart) and a turn without `tabId` have none: the event carries
    `tabId: null`, no tab answers, the tool times out.
  - `answer`: `404` unknown or expired call, `409` already answered, `400` when the body fails the tool's schema.
    Writes `<vaults>/.browser-calls/<fileKey(chat)>/<fileKey(call)>.json` (temp file + rename), once (an in-memory
    flag, reset when the write fails so the tab can retry), then emits `browser-call-done`. The position is passed on as
    the browser gave it, unrounded.
  - Close: the part leaving `running`, or the deadline (90 s + 5 s grace) → drop the call, emit `browser-call-done`,
    remove a stale answer file. The turn's end (abort included) calls `closeVault`, which closes every call of the
    vault, subagent sessions too; `removeChat` runs when a chat is deleted and when an adopted turn ends.
  - `pending(vaultId)`: what a newly connected vault event stream receives after `status` and the replayed agents
    move (`app.ts` events route).
- Prompt body `tabId`: `^[A-Za-z0-9-]{8,64}$`, optional, stored on the queued `Turn` (`config.json` `queued`) and on the
  running turn.

**Web.**

- `lib/client-context.ts`: the tab id from `crypto.getRandomValues` (works without a secure context, e.g. a dev stack
  over plain http), in `sessionStorage`; a page-lifetime id when storage is blocked, so prompts never fail over it.
- `lib/browser-tools.ts`: `user_location` calls `navigator.geolocation.getCurrentPosition({ enableHighAccuracy: true,
  maximumAge: 60_000, timeout: 60_000 })`; `PERMISSION_DENIED` → `{ ok: false, reason: 'denied' }`,
  `POSITION_UNAVAILABLE` / timeout → `no-position`, no Geolocation API → `unsupported`.
- The vault event handler answers a `browser-call` whose `tabId` is this tab's id and whose tool has a handler, once
  per call id (an unknown tool is answered `unsupported`), whichever chat is on screen. Only the shown vault's event
  stream is open: a call while the user looks at another vault is answered only if they switch back before the
  deadline (the pending replay), else the tool times out.
- Chips (`toolLabel`): while running "open the app to share your location", when done the title the tool set.
- iOS: geolocation needs a secure context (HTTPS; `localhost` in dev) and works in the installed PWA. With iOS
  "Precise Location" off the device gives an approximate position, which the tool reports with its accuracy. The proxy
  sends `Permissions-Policy: geolocation=(self)` (`deploy/proxy/Caddyfile`).

### Key decisions

- **Live round-trip for the position,** not a position sent with every prompt (like `openPage`): the AI asks only when
  it needs it, and the channel serves future browser tools that act, not just report.
- **Answer file on the shared volume,** not an HTTP call from the tool or opencode's permission `ask`: no new path from
  opencode (which reads untrusted vault content) to the backend's API; a permission reply carries no data.
- **Announced on the vault event stream,** not the chat stream: it is open whenever the vault is shown, the chat stream
  only while that chat is on screen.
- **Only the tab that sent the prompt answers:** "where am I?" must be answered by the device in the user's hand, not by
  a laptop at home. A duplicated tab shares the tab id; the first answer wins (`409` for the second).
- **No app setting, no per-call confirmation:** the browser's site permission is the switch; declining is an ordinary
  answer. Revisit if prompt injection shows up ([security](security.md#gaps-known-not-built)).
- **Timeout returns text, not a tool error:** the model asks the user instead of retrying. A suspended tab: 90 s, the
  chip says "open the app to share your location", no longer wait.
- **Full device precision** (high accuracy, no rounding, no reverse geocoding), the user's choice: "nearest bakery",
  street questions. Costs a slower fix (up to ~30 s cold) and a more sensitive position.
- **Local time computed on the server from the zone sent with the prompt, as a hidden line, not a `local_time` tool:**
  opencode's system prompt already states the server's date, so the model would rarely call a tool and "today" would
  stay wrong. No wait, no failure path: works with the phone locked and for a queued turn; ~30 tokens per prompt.
- **Turns without a zone use the existing `timezone` setting,** not UTC or a new setting: headless turns and old PWAs
  still date notes in the user's usual zone.
- **Tool call key = opencode's `callID`** (verified in opencode 1.18.25); field name `tabId`, matching *answering tab*.

## Ingest

Five pieces, mostly independent (#131): the ingest service ([above](#ingest-service-deployingest)), the input count,
the Ingest button, `move_to_sources` ([opencode](#opencode-deployopencode)) and Instagram: the Instagram connection
(local mode) or the Instagram worker and its job API (worker mode, #168). **The app
contains no ingest logic:** its only coupling to the vault's skill is the name `ingest` and the generic
`move_to_sources` tool.

### Input count

```mermaid
sequenceDiagram
  participant IS as ingest service
  participant W as backend watcher (chokidar)
  participant S as web store
  participant T as FileTree / Shell
  IS->>W: new Input/mail-…/ (add index.md)
  W->>S: files-changed [Input/mail-…/index.md]
  S->>S: unknown path → refreshFiles()
  S->>T: tree with Input/mail-…/
  T->>T: inputCount(tree) = 7 → badge
```

- **No backend change:** chokidar reports the `add` of the item's `index.md` (it ignores `addDir`), the store re-lists
  the tree on an unknown path, and `listTree` lists folders (dot-folders hidden, so a `.tmp-*` never shows).
- `inputCount(tree)` (`lib/tree.ts`, pure): the direct child folders of the root folder named exactly `Input`, not
  starting with `.`. Client-side because the tree is already complete and live in the browser; a status field would
  duplicate it with its own invalidation.
- `FileTree.tsx` computes it from the unfiltered tree; the `Input` row shows `.input-badge` (`aria-label="7 sources
  waiting to be ingested"`, danger colour token), hidden at 0. Under a tree filter that hides every item, a synthetic
  empty `Input` row keeps the badge visible. `Shell.tsx` puts the same count on the phone's Files tab.
- **Commit reminder:** `VaultStatus.inputChangedCount` (changed paths under `Input/`, from the same `changes()` as
  `changedCount`); the web's `reminderCount` is `changedCount - inputChangedCount`. The Changes list and the pill show
  everything.

### Ingest button

- Rendered in the `Input` row (`trow-act`, `data-testid="ingest-now"`) when the count is > 0 **and** the vault's command
  list (`GET /vaults/:id/commands`, loaded while the count is > 0 and on `commandsNonce`) has `ingest`. The phone's Files
  tab shows the same tree, so it needs no second button (no button in the phone header).
- Disabled with the reason as `title` when offline, in conflict, while `status.busy === 'turn'`, and while starting.
- Store `ingestNow()`: `POST /vaults/:id/chats`, switch to the new chat (wide/tablet: open the chat; phone: the Chat
  tab), `recordCommand(vault, 'ingest')`, then the same prompt path a typed message uses with the text `/ingest`. So
  ADR 0004 holds (the backend expands the skill text, never opencode's command endpoint) and the turn queues like any
  other. Unlike a command chip it sends.
- **The vault's skill** (`.agents/skills/ingest/SKILL.md`, owned by the vault, also used by Claude Code on the Mac): the
  app relies on, but can't enforce, that it handles any queue size in one call, skips items with `unresolved_links`,
  cites `Sources/<name>/index.md`, and finishes one item (pages, then `move_to_sources`, or `mv` without the tool)
  before the next. Everything it reads must lie in the vault. No app skill named `ingest` ships.

### Writing into a live vault without the backend's lock

The backend's `VaultLock` is in-process; the ingest service can't take it, and a backend-driven run under the lock was
rejected (Instagram pacing makes a run minutes long, and writer preference would stall pulls and commits). The service
keeps to operations that are safe next to git and editor work:

| Operation | How | Safe because |
|---|---|---|
| New item | build in `Input/.tmp-<rand>/`, rename to `Input/<name>/` | rename is atomic; `listTree` skips dot-folders; leftovers removed at start. **Not yet:** the pinned ingest-email still writes mail items in place (prerequisite open) |
| Update link state | `index.md` via temp file + `os.replace` | never a half-written `index.md` |
| Touch an item | only while it has `unresolved_links` | once ready, it belongs to the AI and the user |

- **Pull keeps `Input/` in place:** `git stash --include-untracked` removes and later recreates untracked folders, which
  would detach the service's bind mount of `Input/` and race its writes. So the pull's dirty check (`git status
  --porcelain`) and stash take the pathspec `-- . ':(exclude)<root>/Input'`; waiting items stay while the pull
  fast-forwards around them.
- **Commit:** a newly arrived item makes the changed set differ from the reviewed one, so the commit fails with the
  existing `409 changes-moved` and the user reviews again (no partial commits).
- **Accepted:** the user editing an item's `index.md` in the same second the service rewrites it (last writer wins; the
  editor's version check shows the stale-save dialog), and the Mac editing a committed `Input/<name>/index.md` while
  the server resolves it (an ordinary git conflict). A long `/ingest` turn holds the vault lock like any turn.

### Instagram connection

Local mode only (`instagram_source: local`: prodtest and tests); in worker mode the server holds no Instagram session
([Instagram worker and job API](#instagram-worker-and-job-api)).

```mermaid
sequenceDiagram
  participant U as Secrets & keys › Instagram
  participant B as backend (ingest.ts)
  participant S as ingest server.py :8090
  participant IG as Instagram (via egress)
  U->>B: POST /api/ingest/instagram/login {username, password}
  B->>S: POST /instagram/login (Bearer ingest_token)
  S->>IG: login_interactive_free (worker thread, staging dir)
  IG-->>S: 2FA / challenge required
  S-->>B: {state: "code", via: "SMS"}
  B-->>U: "Code sent by SMS" + code field
  U->>B: POST /api/ingest/instagram/code {code}
  B->>S: POST /instagram/code
  S->>IG: login with the code
  IG-->>S: ok
  S->>S: install session (0600) under the lock, IG_USERNAME, forget password
  S-->>U: {state: "connected", account}
```

The browser carries the form, the server does the login: instascraper's password login with a stable emulated device.
The session cookie can't come from the user's browser (instagram.com's `sessionid` is HttpOnly on another origin), and
Instagram has no API for reading other people's posts. A session minted on the server's IP is also the one Instagram
then sees in use.

- **Endpoint routes:** `GET /instagram/status` → `{ state, account?, via?, waitingLinks }`; `POST /instagram/login
  {username, password}` → `{state: "connected", account}` or `{state: "code", via}`; `POST /instagram/code {code}`;
  `POST /instagram/disconnect` (drops a pending login and the session files) → status.
- **Pending login:** a worker thread runs instascraper's `login_interactive_free(username, password, code)`
  (instascraper ≥ 1.1.0); when Instagram wants a code, `code(via)` blocks on a queue that `POST /instagram/code` fills,
  at most 300 s (`expired-code`, 400). One pending login at a time; a new login supersedes it. `POST /login` and
  `/code` wait at most 90 s for the next answer, else `504 login-timeout` and the login is cancelled. Errors:
  `wrong-password` (400), `expired-code` (400), `no-pending-login` (409), `rate-limited` (429: Instagram throttles the
  server's IP — `ClientThrottledError`, `PleaseWaitFewMinutes`, `RateLimitError`; try again later, once),
  `login-failed` (502, with instascraper's reason `<Type>: <message>`, the password removed).
- **Sessions:** each attempt logs in into its own `mkdtemp` staging dir under `/state/instagram-login/` (a copy of the
  old session keeps the device ids stable); only a successful, still-current attempt installs
  `~/.config/instascraper/session-<user>.json` (0600) under the service lock and sets `IG_USERNAME` in instascraper's
  config, so the resolver's client uses it. A pending or superseded login never touches a working session.
- **Status, read from the vaults** (ingest-email stays as it is): `waitingLinks` = Instagram URLs in an
  `Input/*/index.md`'s `unresolved_links` with reason `no-session`; `waiting-for-code` while a login waits for a code;
  `not-connected` without a session; `expired` when such a link's item was rewritten by the resolver after the session
  file was installed (right after a connect it reads `connected` until the resolver has tried again). The status never
  logs in.
- **Username:** `^[A-Za-z0-9._]{1,30}$`, not only dots (a leading `@` is dropped), checked by the backend's zod schema
  and again in the service, because it becomes part of file names.
- **Backend** (`src/ingest.ts`, routes in `app.ts`): `GET /ingest/instagram`, `POST /ingest/instagram/login|code|
  disconnect`, bearer-guarded and zod-validated (`.strict()`, password ≤ 200, code ≤ 20 characters), proxied to
  `INGEST_URL` (`http://ingest:8090`) with the token from `INGEST_TOKEN_FILE` and a 120 s timeout. The service's errors
  keep their status as `{ error, code }`, except 401/403 (a token mismatch), which become `502 ingest-auth` because the
  web app treats every 401 as "log out"; unreachable or not configured is `503 ingest-down` "Ingest service not running".
- **Web** (`InstagramSettings.tsx`): status line, then the form (username, password → Connect, or Reconnect when
  `expired`), the code step ("Code sent by <via>", Verify, Cancel, which only resets the form), or Disconnect when
  connected; `InstagramNotice` in the Vaults list while `expired` ("Reconnect in Secrets & keys"). Types `InstagramStatus`, `InstagramLoginAnswer` in
  `packages/shared`.
- **Dev and e2e:** `compose.dev.yml` sets `INGEST_FAKE_INSTAGRAM_LOGIN=1`, a built-in fake login (password `wrong`
  fails, a user `twofa…` asks for code `000000` by SMS). Prod and prodtest never set it (`compose.test.sh` asserts it).
  Dev runs in worker mode, so the fake login is no longer reachable from the UI; local mode is covered by
  `test_server.py` and the component tests.

### Instagram worker and job API

Worker mode (`instagram_source: worker`: production and dev). The server never scrapes Instagram; an
[Instagram worker](#instagram-worker-toolsinstagram-worker) on the user's machine pulls one post at a time.
[ADR 0006](../../docs/adr/0006-instagram-scraped-by-a-worker.md) has the why.

```mermaid
sequenceDiagram
  participant W as Instagram worker (user's machine)
  participant B as backend /api/ingest/instagram/*
  participant S as ingest server.py :8090
  participant R as ingest-email resolve loop
  participant V as /vaults/*/Input
  W->>W: humanizer gate (night? day ceiling?) → else wait, heartbeat night/resting
  W->>B: POST jobs/claim (worker token)
  B->>S: POST /instagram/jobs/claim (ingest token)
  S->>V: scan unresolved_links for Instagram shortcodes
  S-->>W: 200 {id, url, leaseUntil} | 204
  W->>W: instascraper: get_client, scrape, write_result → <shortcode>/
  W->>B: PUT jobs/<id>/result (tar.gz, Content-Length)
  B->>S: same body, streamed
  S->>S: temp file → check members → extract (filter='data') → rename into results/<id>/
  S-->>W: 204
  R->>S: (filesystem) results/<id>/ exists
  R->>V: map_output → Input/insta-<date>-<owner>-<id>/, link resolved
```

| Public route (backend) | Internal route (`server.py`) | Request | Answers |
|---|---|---|---|
| `POST /api/ingest/instagram/jobs/claim` | `POST /instagram/jobs/claim` | `{name}` | `200 {id, url, leaseUntil}` · `204` no job · `400` bad name · `409 not-worker-mode` |
| `PUT /api/ingest/instagram/jobs/:id/result` | `PUT /instagram/jobs/:id/result` | `application/gzip`, `Content-Length` required | `204` stored or already there · `400 bad-id` / upload ended early · `404 unknown-job` · `411 length-required` (also for `Transfer-Encoding`) · `413 too-large` (> 500 MB, body not read) · `422 invalid-result {message}` |
| `POST /api/ingest/instagram/jobs/:id/failure` | `POST /instagram/jobs/:id/failure` | `{reason, permanent: bool}` (reason cut at 200) | `204` · `400` · `404 unknown-job` |
| `POST /api/ingest/instagram/jobs/:id/release` | `POST /instagram/jobs/:id/release` | — | `204` (also without a lease) |
| `POST /api/ingest/instagram/worker/heartbeat` | `POST /instagram/worker/heartbeat` | `{name, version (≤ 64), state, message?}` | `204` · `400` (unknown state, bad name, no version) |
| `GET /api/ingest/instagram` (main token only) | `GET /instagram/status` | — | adds `source`, `workers`, `queue` |

- **Ids and names:** `:id` is a shortcode, `^[A-Za-z0-9_-]{5,40}$`, checked in the backend (after the token) and again
  in `server.py` before it touches a path (`400 bad-id`). A job's `url` is always `https://www.instagram.com/p/<id>/`
  (it serves Reels too). Worker names `^[A-Za-z0-9._-]{1,64}$`. JSON bodies at most 10 kB on both hops.
- **Backend** (`ingest-worker.ts`): an `express.Router` (case-sensitive, strict) mounted with
  `app.use('/api/ingest/instagram', …)` **before** `app.use('/api', api)`. It handles exactly the five job routes with
  `bearerAuthAny([workerToken, token])`; every other path falls through to the main router and its `bearerAuth`, so the
  worker token is refused everywhere else. JSON routes: `express.json({ limit: 10_000 })` and `forwardIngest` (status,
  type and body passed through, 204 included; unreachable → `503 ingest-down`, an ingest 401/403 → `502
  ingest-auth`). The result route has no body parser: `fetch` with `body: req`, `duplex: 'half'` and the request's
  `Content-Length`, 10-minute timeout; no `Content-Length` → `411` from the backend itself (no chunked uploads). The
  ingest service always gets the ingest token, never the worker token. Without a configured worker token
  (`settings.json` `ingest.worker_token` absent or its file missing) only the main token works on these routes.
- **Jobs** (`server.py`, under `svc.lock`): every claim walks `Input/*/index.md` and collects the shortcodes in
  `unresolved_links` URLs (ingest-email's regex `instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)`). A shortcode is
  **wanted** while some item has it or a worker holds its lease. Its state: `ready` (a result dir exists), `failed`
  (permanent marker), `leased` (a live lease), `backingOff` (a non-permanent marker younger than `min(count, 24)` h),
  else `waiting`. A claim leases the oldest waiting shortcode (by its oldest item's mtime) for 30 min to the claimer's
  name. Leases live in memory; a restart frees them.
- **Result upload:** results already there → `204` at once (idempotent); not wanted → `404 unknown-job` (the body
  drained); a live lease is not required, so a late upload still counts. The body goes in 1 MiB chunks to a temp file
  in `/state/instagram/incoming/`, then the tar members are checked **before anything is extracted**: all flat or all
  in one `<shortcode>/` directory, at most 40 files, every path part `^[A-Za-z0-9._-]+$` and not `.`/`..` (absolute
  paths refused, not stripped), regular files only (type `0`: no links, devices, contiguous or sparse files), at most
  1 GiB unpacked, no name twice, `post.md` and `metadata.json` (≤ 1 MiB) present. The decompressed stream is bounded
  as well (1 GiB + 1 MiB slack, and 1 MiB of headers while the members are scanned, since tarfile reads GNU long-name
  and pax headers whole). `extractall(filter='data')` writes the checked files flat into a staging dir; what landed
  must be exactly those files, and `metadata.json` must be JSON naming this shortcode. Then `os.replace` into
  `results/<id>/`. Any failure → `422` naming the rule, nothing kept. Success ends the lease and removes a
  non-permanent marker.
- **Failure:** `<id>.failed.json` `{reason, permanent, at, count}`, `count + 1`, permanent when reported so, already
  permanent, or at the 5th failure; written atomically; ends the lease.
- **Heartbeat:** the last `{name, version, state, message, lastSeen}` per worker in memory, written to
  `/state/instagram/workers.json` (atomic) on every state change and at most once a minute otherwise; loaded at start.
- **Pruning,** on a claim, at most hourly: results and markers unchanged for 7 days, `incoming/` leftovers older than a
  day, workers not seen for 30 days.
- **Status** in worker mode: `source: "worker"`, `waitingLinks` = unresolved links with an Instagram shortcode (any
  reason), `workers` (seen in the last 30 days, newest first), `queue {waiting, leased, backingOff, ready, failed}` by
  shortcode; `expired` is computed only in local mode. Local mode answers as before plus `source: "local"`; there a
  claim is `409` and result/failure are `404 unknown-job`.
- **ingest-email** (pinned commit on its branch `instagram-worker`): `Outcome.wait(reason)` keeps a link in
  `unresolved_links` with its `attempts` unchanged, and `resolve_source` rewrites `index.md` only when the links or the
  body changed. Its Instagram resolver in worker mode never imports instascraper: `<results_dir>/<code>/` →
  `map_output` into a new `insta-…` item, as a local scrape (the result dir stays for other vaults; `server.py` prunes
  it); a permanent marker → `give_up(reason)`; a non-permanent one → `wait(reason)`; nothing → `wait("worker")`. A
  result wins over a marker; an unreadable marker counts as none; no `instagram_results_dir` → `wait` with that reason.
- **Web** (`InstagramSettings.tsx` `WorkerPanel`): in worker mode the worker rows (name, last seen, message, state
  pill), a `needs-login` hint per worker, the counts, the two-workers warning (two seen within an hour), and the link
  to `docs/instagram-worker.md` on GitHub, instead of the Connect form; `InstagramNotice` for `needs-login` and for
  waiting links with no worker seen for an hour. `InstagramStatus` in `packages/shared` has `source`, `workers?`,
  `queue?`.
- **Tests:** `test_server.py` (job API, uploads, markers, status), `ingest-worker-routes.test.ts` (auth scope,
  streaming, pass-through), `InstagramSettings.test.tsx`, the worker's pytest suite (fake server, stubbed instascraper),
  and `e2e/instagram-worker.spec.ts`, which plays the worker over HTTP with the dev stack's worker token. Instagram
  itself is never called in tests.

## The agents move

The app moves a vault to the `.agents` standard (`AGENTS.md`, `.agents/skills/`) by itself; see
[domain.md](domain.md#agents-move) for the rules and the user-facing result.

- **When:** after every successful clone or pull (the pull before each turn included) and on `POST /vaults/:id/open`
  (`Vaults.agentsMove`), under the exclusive lock the caller holds, so no turn runs. Skipped in conflict (it would only add to
  it); it runs on the next pull or open after the conflict is resolved. It never throws into the caller (failures are logged).
- **`scanLegacy(vaultRoot)`:** names in `.claude/skills/*/` (directories only; a plain file `.claude/skills` is the link stub and
  means "already moved"), `.claude/commands/*.md`, and whether `CLAUDE.md` is anything but `@AGENTS.md` (or `AGENTS.md` exists
  without a `CLAUDE.md`). Vault root only. The scan left after a move is remembered per vault (`legacySeen`), so clashes that
  haven't changed don't repeat the move or the notice on every pull.
- **`migrateToAgents(repo)`** never overwrites and commits nothing:
  - `CLAUDE.md` → `AGENTS.md`, unless `AGENTS.md` exists or `CLAUDE.md` mixes `@AGENTS.md` with other lines (clash: both stay,
    `AGENTS.md` goes into `skipped`). Each line that is only `@<path>` is replaced by that file's content, one level deep,
    relative to the vault root, only for an existing file inside it that is not gitignored (`AGENTS.md` gets committed; a
    path outside, a missing or an ignored file stays as text). Then `CLAUDE.md` becomes `@AGENTS.md`. The pasted files stay
    and are returned as `inlined`. `AGENTS.md` without `CLAUDE.md` gets `CLAUDE.md` = `@AGENTS.md`;
  - each `.claude/skills/<n>/` → `.agents/skills/<n>/` (whole folder), unless that exists (`skipped`);
  - each `.claude/commands/<n>.md` → `.agents/skills/<n>/SKILL.md` with `name` and `description` (its own, else its first line,
    at most 200 characters), other frontmatter dropped, body unchanged; `.claude/commands/` is removed only when empty;
  - when anything went into `.agents/skills/` and `.claude/skills` has no content left, the **skill link** replaces it. The
    clones run with `core.symlinks=false`, so the backend writes the stub file `.claude/skills` (content `../.agents/skills`,
    **no trailing newline**) and stages it as a link with `Repo.stageSymlink`: `git rm -r --cached`, then `git update-index
    --add --cacheinfo 120000,<blob>,.claude/skills`. The commit's `git add -A` keeps the index mode for the stub, so the
    commit carries a real symlink. Staging it is the only index write outside a commit. A pull resets the index and stashes the
    work tree, so `restageSkillLink` stages the link again whenever the stub is there but the index lost it;
  - returns `AgentsMove { moved, converted, instructions, inlined, skipped }` (`@karpathy/shared`).
- **Event:** a non-empty result is emitted as the vault event `{ type: 'agents-move', at, …AgentsMove }` on
  `GET /vaults/:id/events` and kept as the vault's last move (in memory), which a client that connects later receives before
  the live events. `at` identifies the move.
- **Web:** the store shows each move once (`karpathy.shownMoves` in localStorage, keyed `<vault>:<at>`, last 50), sets
  `agentsMove`, bumps `commandsNonce` and refreshes files and changes. `MoveNotice` (`Dialogs.tsx`, inside `#app`) shows
  "Moved to the .agents standard": skills now in `.agents/skills/`, rules now in `AGENTS.md`, "not moved, name exists: …", each
  pasted file with a **Delete** link (`DELETE /file`), and **Review** (the Changes view). It stays until dismissed or the
  vault changes.
- **Effects:** the move changes `SKILL.md` stamps, so the next command list refreshes opencode. The file writes reach the
  editor through the watcher's `files-changed` events like any change on disk. A moved skill folder shows as one delete plus
  one add per file in the uncommitted changes.

## Outline and properties

Two note-pane features (#79, #82), web only: no route, no API change.

```mermaid
flowchart LR
    subgraph outline["Outline (#79)"]
      OL["lib/outline.ts<br/>collectHeadings, outlineOfText,<br/>currentHeading"]
      NI["lib/noteinfo.ts<br/>countText, readingMinutes"]
      OP["OutlinePanel<br/>sheet or panel"]
    end
    subgraph props["Properties (#82)"]
      FM["lib/frontmatter.ts<br/>parseProps, editFrontmatter,<br/>checkEdit"]
      SC["lib/schema.ts<br/>DEFAULT_SCHEMA, parseSchema,<br/>validate"]
      PP["PropertiesPanel"]
      HF["lib/cm.ts<br/>hideFrontmatter"]
    end
    ED["Editor.tsx"]
    NP["NotePane"]
    ST["store.tsx<br/>schema, propsView"]
    OL & NI --> OP --> NP
    FM & SC --> PP --> NP
    HF --> ED
    ED -->|outline, onFrontmatter,<br/>selectionText| NP
    NP -->|applyChange| ED
    ST --> NP
```

**Outline.** Both modes read the headings with the editor's Lezer Markdown parser (`commonmarkLanguage`), so the
list is the same in Write and Read mode; code drops out by the grammar, the frontmatter (its closing `---` would make
`title: x` a setext heading) and `%%comments%%` are skipped explicitly (`frontmatterEndLine`, `commentRanges` in
`lib/markdown.ts`, shared with the editor's embed and line plugins). Write mode reads them from CodeMirror's syntax
tree (`ensureSyntaxTree`, kept up to date incrementally; `outlineOfText` is the fallback for a tree not ready in
50 ms), Read mode from `outlineOfText(text)`. While typing, the outline and the note info follow a *settled* copy of
the text, set once no edit came for 300 ms (the pause is keyed on the editor's `onChange`, not on renders); the list of
outline items is memoized, so a note with thousands of headings re-renders only when they or the current one change.
A jump: Write mode `gotoLine(line, { focus: false, align: 'start' })`, Read mode `scrollToLine(scroller, line,
'top')` plus the `hit` class for 1.5 s; no history entry. The current section comes from a rAF-throttled scroll
listener (`topLine()` / `topBlockLine()` → `currentHeading`). Phone: a bottom sheet (`aria-modal`, scrim, grabber,
inside the transformed pane so it sits above the tab bar); tablet: a floating panel that closes on a jump or a tap
outside; wide: the same panel, open across notes. Escape is handled on `document` with `preventDefault`, so the
Shell's window handler skips it. Note info counts with `Intl.Segmenter` (words: `isWordLike`; characters: graphemes
without line breaks) on the body (`splitFrontmatter`), or the selection: Write mode `selectionText()` clipped past
the frontmatter, Read mode the DOM selection inside `.rd`, read on the button's `pointerdown` (iOS clears it on tap).

**Properties form.** The frontmatter comes from the editor (`onFrontmatter`: `{ from, to, text }` in CodeMirror's
positions, reported on create and when that text changes), so form edits and the editor agree on offsets also for
CRLF notes; NotePane keys it by note, so another note's report never shows. `parseProps` parses with `yaml`'s
`Parser` + `Composer({ keepSourceTokens })`; errors, warnings, a non-map, keys that print the same (`1` / `"1"`) and
an unresolvable alias make it unreadable (the YAML lines show). Editable: one-line plain or quoted scalars, one-line
flow lists and block lists of them; the rest is `raw`. Edits follow [ADR 0005](../../docs/adr/0005-frontmatter-edits-through-the-yaml-cst.md):

| Edit | How the new text is made |
|---|---|
| `set` on a scalar | `CST.setScalarValue` on the value's token, in its own style when that reads back as the value, else `PLAIN`, else double-quoted; then `CST.stringify` |
| `set` on an empty value | a splice after `key:` (a comment after it stays) |
| `add` | flow: `, item` after the last item (or into `[]`); block: a new line with the last item's prefix; empty value: `[item]` |
| `remove` | flow: the item and its separator; block: the item's line (its comment goes with it); the only block item: `key: []` |
| `addKey` | a new last line before trailing blank lines; lists as flow lists |

Every result passes `checkEdit` (parses, other properties equal and in order, only the pair's lines or the line after
them changed, the value reads back as intended) or is refused. `NotePane.editProp` computes the edit on the form's
text and calls `applyChange(minimalChange + from, expect)`, which writes only while the editor still holds `expect`
(an AI reload or pull meanwhile: nothing written, a toast); the transaction is a normal user change (`isolateHistory`,
`input.properties`), so autosave, drafts and undo treat it like typing. `hideFrontmatter(onBlocked)` is a
`StateField` with one block `Decoration.replace` over the frontmatter lines plus `atomicRanges`, and a
`transactionFilter` that clamps cursor moves and select-all to the body and drops typed or deleted changes that would
reach the hidden lines (Backspace at the body start) while calling `onBlocked`, which shows the lines. A search match
(`select.search`) or a `gotoLine` into the frontmatter shows them too. The store loads `.karpathy/schema.json` when a
vault becomes usable and on `files-changed` naming it (404 → default; invalid → default and a toast once per problem
and vault); `propsView` is localStorage `karpathy.propsView`; the per-note YAML override `yamlFor` lives in NotePane
and clears on a note change. `PropertiesPanel` renders one field per property (select with an extra flagged option
for a value outside the enum, date + Today, decimal input that keeps non-canonical numbers as typed, switch, chips
with an Add field and note suggestions for link lists, `raw` with "Edit in YAML"), violations under their field,
missing required keys as their own rows, and **+ Property** (a datalist of the schema's missing keys, any
`isPropertyName` key; starting value `[]`, today or `""` by kind).

## Media embeds

```mermaid
flowchart LR
    subgraph shared["packages/shared"]
      T[MEDIA table, mediaKind, rawType<br/>ext → kind, Content-Type]
    end
    subgraph backend["apps/backend"]
      R["GET /vaults/:id/raw?path="] --> V[Vaults.rawFile<br/>resolveInVault]
    end
    subgraph web["apps/web"]
      MDL[lib/markdown.ts<br/>embeds → placeholders]
      MED[lib/media.ts<br/>parseEmbed, resolveEmbed,<br/>objectUrl cache]
      EMB[lib/embed.ts<br/>mountEmbed, file card]
      CMX[lib/cm.ts<br/>embed block widget]
      NP[NotePane: Read view,<br/>media view, editor]
      CP[ChatPane]
    end
    T --> R & MED
    MDL --> NP & CP
    MED --> MDL & CMX & EMB
    EMB --> NP & CMX & CP
    MED -->|"HEAD / GET (Bearer)"| R
```

Four surfaces show media: Read mode, Write mode, chat replies and the media view (a file opened on its own). All of
them end in one plain-DOM function, `mountEmbed(el, resolved, ctx)`, which creates elements with `createElement` and
an object URL as `src` (no HTML strings). While bytes load, a skeleton holds the space, using the natural size the
cache remembered from an earlier load when there is one, so Back lands without layout jumps.

- **Raw route:** `GET /vaults/:id/raw?path=` behind the bearer auth. `Vaults.rawFile` applies the note path rules (no
  `..`, no `.git`, no hidden files, no symlinks); `res.sendFile` streams and answers `HEAD` and `Range`. Headers:
  `Content-Type` from `rawType` (media table; `application/pdf`; else `application/octet-stream`),
  `Content-Disposition: attachment` for everything that isn't a media kind, `nosniff`, `Cache-Control: no-store`. No
  ETag: hashing a large video per request is the waste avoided. `GET /file` is unchanged and still gives the version
  that Delete needs when a media file is opened from the tree.
- **Resolution** (`resolveEmbed(embed, notePath, paths)`): the wiki form goes through `resolveWikilink` (exact path,
  path suffix, basename; ties: the note's folder, then the shortest path, then A–Z); the Markdown form is URL-decoded
  and joined with the note's folder; `http(s):`, `//`, `data:` → `remote` (a plain link). Results: `media`, `file`,
  `note` (rendered as a wikilink), `missing`, `remote`.
- **Object-URL cache** (`objectUrl`, `invalidate`): key `vault\0path`, the pending promise is shared. A `HEAD` asks the
  size first; over 50 MB it resolves `tooLarge` without transferring bytes (not cached), unless `force` (Load anyway).
  SVGs are sanitized with DOMPurify's SVG profile before they become a blob. Budget 200 MB, least recently used entries
  revoked; entries in use are held (`release()`) and never evicted. `files-changed` invalidates the changed paths;
  switching vault or logging out invalidates the vault.
- **PDF Open:** `window.open('', '_blank')` synchronously in the click (Safari blocks it after an `await`), then the
  tab's location becomes a blob re-typed `application/pdf`, so only the browser's PDF viewer can show it.
- **Tap on an image** calls `onOpen(path)` → `store.openNote`, which pushes a history entry.

## Vault search

`GET /vaults/:id/search?q=` (#138) answers from an in-memory index per vault root (`SearchIndex` in `search.ts`, held
in the vault's runtime state), not by scanning files.

- **Index:** MiniSearch (BM25) over five fields per file: `title` (file name without extension, boost 3), `headings`
  (Markdown heading lines, 2), `meta` (the frontmatter block, 1.5), `path` (folders, 1), `body` (the text without
  frontmatter, 1). The files are ripgrep's listing (`rg --files`: hidden and git-ignored files left out, as the old
  ripgrep search did). Binary files (a NUL byte in the first 8 kB) and files over 1 MB are indexed by name and path only.
  Lines of base64 (mail attachments) and "words" over 40 characters are skipped. MiniSearch keeps no document text.
- **Terms:** a word is `[\p{L}\p{M}\p{N}]+` of the NFC text (so `only-name-needle` is three words). Its term is the
  Snowball stem (`@orama/stemmers`) of the lower-cased word in the file's language, then folded: diacritics stripped,
  `ß` → `ss`, `æ`/`œ` → `ae`/`oe` (`fold`). German first turns `ue`/`oe`/`ae` into umlauts (Snowball's German2), so
  `Handtuecher`, `Handtücher` and `handtucher` all give `handtuch`.
- **Language per file, at index time:** `lang:`/`language:` in the frontmatter if it names a supported language, else
  `franc-min` (a trigram model: small, local, deterministic, no LLM) on the first 600 characters of the body,
  restricted to German, English, French, Spanish and Italian (the languages with a stemmer). Under 40 characters there
  is no language: the file's words get the stems of all five languages. The first build logs the file count, time and
  languages (`search index: N files in T ms, languages {…}`).
- **Query:** words, or `"quoted phrases"`. Each word matches by any of its variants (the folded word and its folded
  stem in each language; best variant's score counts); every word must match (AND); scores add up. The last word,
  unless quoted, is also a prefix. A word that matches nothing at all is looked up fuzzily (edit distance up to a
  quarter of its length, at most 2). A phrase is matched by its words, then kept only if one line (or the path) holds
  the folded words in a row. A word without letters or digits (`++`) is ignored.
- **Order:** files whose name matches every word first (#99), then by score, then by path.
- **Hits:** files are read in that order: each matching line (up to 20 per file; a line over 300 characters is cut
  around its first match) becomes a hit with `ranges`, the offsets of the matched words (a word matches when one of its
  terms matched; a phrase marks its whole run). A file found only by name or path gets one hit with line 0. At most
  200 hits; `truncated` says there were more. The web app marks the ranges (`markedSnippet`), centered like before (#54).
- **Freshness:** the index is built on the vault's first search, or in the background when an app opens the vault
  (`Vaults.open`), in chunks of 64 files that yield to the event loop. Afterwards it is never rebuilt, only caught up
  before a search: a path reported by the watcher (raw events, not debounced) or saved, uploaded or deleted through
  the API is re-read alone; a folder event, a pull, a discard, a conflict resolution, an upload that moves a note into
  its own folder or an attachment tidy-up re-lists the files and re-reads those whose size or mtime changed. A root
  change or a new clone starts a new index; removing the vault drops it.
- **Cost:** about 60–85 MB heap and some 10–20 s for a synthetic vault of 10,000 notes of 3 kB each (on a loaded dev
  host), most of it stemming, MiniSearch inserts and language detection; a query over it takes 0.3–1 s when thousands
  of files match, milliseconds otherwise. Typical vaults (hundreds to a few thousand notes) build in well under 5 s.

## Text files

Notes, HTML pages and code files (#126); the kind comes from `fileKind` ([Web app](#web-app-appsweb)).

```mermaid
flowchart TB
    NP[NotePane.tsx] --> LG[lib/lang.ts<br/>fileKind + languageFor]
    NP --> ED[Editor.tsx<br/>kind note: liveMarkdown<br/>kind code: codeView]
    ED --> LD["@codemirror/language-data<br/>one lazy chunk per language"]
    NP --> HV[components/HtmlView.tsx<br/>sandboxed srcdoc frame]
    HV --> HP[lib/html-page.ts<br/>preparePage]
    HP -->|"load(path): GET /raw (Bearer)"| R[backend raw route]
```

- **Code view:** see the Editor bullet in [Web app](#web-app-appsweb). The PWA precache (`**/*.js`) includes the
  language chunks on purpose, so code files color offline too.
- **Preparing an HTML page** — `preparePage(html, ctx)`, pure apart from the injected `load(path)`:
  1. Parse with `DOMParser`, sanitize with DOMPurify (`WHOLE_DOCUMENT`, `<style>` and `style=` kept): drops
     `<script>`, event handlers, `javascript:` URLs, `<form>`, `<iframe>`, `<object>`, `<embed>`, `<base>`,
     `<meta http-equiv>`.
  2. `<link rel="stylesheet">` to a vault file → its text as `<style>`; remote or missing stylesheets removed.
  3. `<img src>` / `<source src>` to a vault file → a `data:` URL (up to 10 MB, else only the alt text); remote
     images → a link with the alt text, as in notes.
  4. `<a href>`: external → `target="_blank" rel="noopener noreferrer"`; a vault path → `#/<vault>/<path>` with
     `target="_top"`; `#anchor` stays.
  5. Relative paths resolve against the page's folder and never outside the vault root (the embeds' check).
- **Showing it** — `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
  srcdoc=… title=<file name>>`. No `allow-scripts`, no `allow-same-origin`: the page runs no code and has an opaque
  origin, so it can't reach the app's token, storage or DOM even if sanitizing missed something. `srcdoc` inherits the
  app's CSP (`img-src 'self' data: blob:`, `style-src 'self' 'unsafe-inline'`), which is why images go in as `data:`
  and stylesheets inline; the e2e `cspGuard` fails on any violation. The frame fills the pane
  (`calc(100dvh - 190px)`) and scrolls itself (an opaque frame can't be measured). A vault link navigates the top
  window to its hash route, so `popstate` opens the file and the back arrow works from a page too. Re-prepared when
  the text changes or the mode switches to Read; a later preparation keeps the old page until the new one is ready;
  one that fails shows a short message.

```mermaid
flowchart LR
    T[file text] --> S[DOMPurify<br/>no scripts/forms/frames]
    S --> L[vault CSS → inline style]
    S --> I[vault images → data: URLs<br/>remote → links]
    S --> A[links: vault → app route, external → new tab]
    L & I & A --> F["iframe sandbox (no scripts,<br/>opaque origin) srcdoc"]
```

### Back arrow

```mermaid
stateDiagram-v2
    [*] --> NoArrow: first file / reload / deep link
    NoArrow --> Arrow: push file B (prev = A)
    Arrow --> Arrow: push file C (prev = B)
    Arrow --> NoArrow: Back to an entry with prev = null
    Arrow --> Arrow: Back to an entry with prev ≠ null
    Arrow --> NoArrow: switch vault (prev = null)
```

A reload restores `history.state` of the current entry, so the arrow is still right after a reload mid-session.
Details: the Back arrow bullet in [Web app](#web-app-appsweb).

## Emails

`.eml` files (#166), web app only: the backend serves them like any file (`GET /file`, and `GET /raw` as
`application/octet-stream` + attachment, which a `fetch` ignores).

```mermaid
flowchart TB
    NP[NotePane] -- "kind = email" --> EV[EmailView]
    EV -- "binary: HEAD, then GET /raw<br/>UTF-8: note.loaded" --> B[bytes]
    B -- "lazy import" --> EM["lib/email.ts<br/>parseEmail (postal-mime)"]
    EM -- "bodyHtml: cid → data:" --> PP[preparePage]
    PP --> FR["sandboxed srcdoc frame (SANDBOX)"]
    EV --> HB["subject, header block, text body,<br/>attachment buttons: plain React DOM"]
```

- **Bytes:** a UTF-8 mail (most are: quoted-printable and base64 are ASCII) came whole with `GET /file`, so
  `EmailView` parses `TextEncoder().encode(note.loaded)` (byte-exact, CRLF included); only a `binary: true` mail is
  fetched again (`rawHead`, then `api.raw`). Either way over `MAX_PREVIEW_BYTES` (50 MB) it shows a file card with
  "Load anyway" first. Bytes stay out of the object-URL cache. `store.tsx` `load` drops a local draft of an email
  (one left from when `.eml` opened as code) instead of restoring or autosaving it.
- **Parsing** (`lib/email.ts`, own chunk via dynamic `import()`, so the main bundle and precache stay as they were):
  `parseEmail` wraps **postal-mime** (pinned `4.0.11`; MIT-0, no dependencies; RFC 2047 headers, charsets incl.
  Latin-1, quoted-printable, base64, `multipart/*`) with `attachmentEncoding: 'arraybuffer'` and
  `rfc822Attachments: true` (a forwarded mail stays a part). Result: subject, From / To / Cc / Reply-To as
  `Name <address>` (groups flattened), Date (invalid → none), html, text, `inline` and `attachments`. postal-mime
  accepts any bytes, so `parseEmail` throws when there is no subject, From or body ("This email can't be shown.").
- **Inline vs attachment:** an image part of at most 10 MB (`MAX_IMAGE_BYTES`, shared with HTML pages) whose
  Content-ID a `src="cid:…"` in the HTML names is inline; the reference is percent-decoded and compared without case
  (RFC 2392). Every other part is an attachment, so nothing goes missing (an image named only from CSS, one too big,
  a forward). A nameless one is `attachment-N.<ext>`.
- **Body:** `bodyHtml` (DOM) sets each `cid:` `src` to its part's `data:` URL (an unknown one keeps only its alt
  text); then `preparePage` with no vault files (relative references resolve to nothing) makes it inert: no scripts,
  forms, frames, `meta`, `base`; remote images become links (no tracking pixels: the frame inherits the app's CSP);
  every link, image-map `<area>` included, opens in a new tab, and a `#` link loses its `target`, so nothing in a
  page can move the app. Shown in `iframe.html-view` with `SANDBOX` (no `allow-scripts`, no `allow-same-origin`). No
  HTML part → the text part in `.email-text` (`pre-wrap`, a text node).
- **Header block and attachments:** React text nodes only; no mail HTML reaches the app DOM. The subject shows as
  `.email-subject` (`.note-title` is screen-reader only). An attachment is a button: a tap makes a `blob:` URL of its
  bytes as `application/octet-stream` (never the mail's type, so an HTML or SVG attachment can't open as a page of
  the app), clicks a temporary `<a download>` and revokes the URL.

## Chat context usage

#140. Shared types (`packages/shared`): `ContextUsage { used: number; limit?: number }`; `ChatMessage.context?`
(assistant messages), `ChatSummary.context?` (from the last assistant message) and `ChatSummary.lastEntryAt?` (time
of the last message, any role). `updatedAt` stays opencode's updated time; the list shows `lastEntryAt ?? updatedAt`.

```mermaid
sequenceDiagram
    participant W as ChatList (poll 3 s)
    participant B as ChatService.list
    participant H as OpencodeHarness
    participant O as opencode
    W->>B: GET /vaults/:id/chats
    B->>H: listSessions(dir)
    H->>O: session.list(roots, 200)
    loop sessions with time.updated ≠ cached (4 at a time)
      H->>O: session.messages(id, limit 4)
    end
    H-->>B: [{id, title, updatedAt, lastEntryAt, context}] newest first
    B-->>W: + turn state
```

- **Used:** the last AI reply's tokens (what opencode's TUI shows as context), not a sum: each request re-sends the
  conversation. After a compaction it drops.
- **Limit:** the window of the model that reply ran with (`ModelLimits`, from `models()` = the provider config in
  `deploy/settings/`, e.g. `qwen2.5:3b … limit: { context: 16384 }`), never a table in the app.
- **Cache:** `lastEntries` keeps one entry per session in memory (dies with the process); a cold start loads each
  chat once, afterwards normally only the chat that changed.

## Chat titles {#chat-titles}

#148. Rules and terms: [domain.md](domain.md#chat-title). The backend runs a title job when a turn ends; the model
behind it (title model) and the vision model are set like the chat model ([Settings](#settings)).

```mermaid
sequenceDiagram
  participant W as Web (ChatPane)
  participant B as Backend (ChatService → ChatTitles)
  participant O as opencode (agent chat-title)
  W->>B: POST /prompt (turn n)
  B-->>W: stream … turn idle (stream ends)
  B->>B: endTurn → afterTurn(vault, chat, endedAt)
  B->>O: messages(chat) up to endedAt → n user messages
  alt n == 2 or n % 10 == 0
    B->>O: createSession('/vaults') + promptSync(agent chat-title, model = title model)
    O-->>B: title
    B->>O: abort + deleteSession
    B->>O: setTitle (n == 2) | store suggestion (n % 10 == 0, drifted)
    B-->>W: vault event {type: chat-title, chatId, title, titleSuggestion?}
  end
  W->>B: PATCH /chats/:chatId {title} (Rename) | DELETE /chats/:chatId/title-suggestion (Keep)
```

- **Job** (`chat-title.ts`, `ChatTitles`, shaped like `commit-message.ts`): `afterTurn(vaultId, chatId, endedAt)` is
  called, not awaited, from `ChatService.endTurn` after the turn finished. It reads the chat's messages created up to
  `endedAt` (a queued prompt already sent doesn't count); `n` = user messages. `n === 2` → generate; `n >= 10 && n % 10
  === 0` → drift check; else nothing. Never throws: a failure is logged once with `console.warn`.
- **Prompt:** the conversation as `User:` / `AI:` blocks of text parts (each cut at 1 500 characters, the whole at
  12 000, oldest blocks dropped first) and "Write the title of this conversation." A drift check sends only the
  messages from the tenth-last user message on.
- **Drift rule in code:** `sameTopic(fresh, current)`: significant words are 4+ letters, compared by their first four
  letters ("tomato" ~ "tomatoes", "trip" ~ "trips"); the same topic needs at least half of the fresh title's significant
  words in the current one (one generic word such as "tips" isn't enough); a fresh title without any counts as the same. Asking the model
  "does the title still fit? KEEP or a new title" got `KEEP` from the dev model 3 of 3 times after a complete change of topic.
- **Throwaway session in `/vaults`:** `createSession('/vaults', 'chat title')`, `promptSync(…, { agent: 'chat-title',
  model: settings.titleModel || settings.model })`, 30 s timeout, abort and delete afterwards (also when the timeout hit
  while the session was still being created). `/vaults` is the vaults dir itself, which no vault's chat list includes
  (a list shows the sessions of its own directory), so the job never shows there; it is also not in a vault, so a skill
  refresh can't cut it off. Cost: its tokens don't show in Usage (sums the vault dirs). The session's cwd is every
  vault, so its isolation rests on the agent's `"*": "deny"` (tested): injected text in a chat can at most shape a title.
- **Clean and write:** `cleanTitle` takes the first non-empty line, strips Markdown, quotes, a `Title:` prefix and a
  trailing period, caps 120 characters; empty or `KEEP` → nothing. Before writing, the chat's title is read again: if it
  changed (a rename) or the chat is gone, nothing is written. Turn 2: `harness.setTitle` (not if the title is equal).
  Drift: store the suggestion in `config.json` `titleSuggestions[vault][chat]`. Then `emit(vaultId, { type:
  'chat-title', chatId, title, titleSuggestion? })` on the vault event stream, after the throwaway session is gone.
- **Routes** (`app.ts`): `ChatSummary.titleSuggestion?` and `ChatDetail.titleSuggestion?` come from the store.
  `PATCH /vaults/:id/chats/:chatId { title }` (trimmed, 1–500 characters) → `ChatTitles.rename`: `setTitle`, clears the
  suggestion, emits `chat-title`. `DELETE /vaults/:id/chats/:chatId/title-suggestion` → `dismiss`: clears it, emits
  `chat-title` with the current title. Deleting a chat or a vault drops its suggestions (`forget`).
- **Event:** `VaultEvent` gains `{ type: 'chat-title'; chatId; title; titleSuggestion? }`. Web: `store.tsx` `onEvent`
  keeps it as `chatTitle` (`{ chatId, titleSuggestion?, nonce }`); the chat list reloads on every change, and the open
  `ChatPane` sets or clears its suggestion from it.
- **Web:** `ChatPane` shows the **title suggestion bar** above the composer while the open chat has a suggestion:
  "Rename this chat to “…”?" with **Rename** and **Keep** (`api.renameChat` and `api.keepChatTitle`, the two routes above).
- **Vision model file:** `vision-model.ts` `syncVisionModel` writes `<vaults>/.vision.json` `{ "model": "<id without
  the gateway prefix>" }` atomically (temp file + rename), or removes it while the default applies. Called at backend
  start and after every `PATCH /settings` that touches `visionModel` (a failing write is logged and doesn't fail the
  save). The file sits on the vaults volume outside every clone; opencode's `look_at_image` reads it per call
  ([opencode](#opencode-deployopencode)), so a change applies without a restart.

## Uploads

```mermaid
flowchart LR
    subgraph web["apps/web"]
      AB[AttachButton<br/>Take photo · Choose file]
      AT[lib/attach.ts<br/>prepare, uploadName]
      ED[NotePane + Editor<br/>track/insert, drop, follow a move]
      CP[ChatPane<br/>chips, send]
    end
    subgraph backend["apps/backend"]
      R["POST /vaults/:id/raw?name=&note= | &source="]
      U[Vaults.upload<br/>checkNote, sourceFolder, writeNew]
      MV[moveIntoOwnFolder<br/>shared rewriteLinks]
      P["POST …/prompt {text, attachments}"]
      C[chat.ts: checkAttachment<br/>→ harness file parts]
      S["GET /settings → modelInput"]
    end
    O[opencode]
    AB --> AT --> ED & CP
    ED & CP -->|"binary body, Bearer"| R --> U --> MV
    CP --> P --> C -->|"promptAsync: text + file:// parts"| O
    S --> CP
```

- **Route:** `POST /vaults/:id/raw?name=<file>` plus exactly one of `note=<page>` (editor) or `source=new&at=<local
  YYYY-MM-DD-HHMMSS>` / `source=<upload-… folder>` (chat). The body is the file's bytes: `express.raw({ type: () =>
  true, limit: MAX_UPLOAD_BYTES })` on this route only, so the JSON API is unchanged; `entity.too.large` → `413
  too-large`. Response `UploadResult { path, version, size, moved?, rewritten? }`, `201`. Under the shared `save` lock;
  `423` in conflict.
- **Name** (`checkUploadName`): no folder, no leading dot, no `#^[]|`, the new-file-name rules, then uploadable (`415
  not-uploadable`, extension only). **Note** (`checkNote`): an existing `.md`, no hidden segment, the new-file-name
  rules. **Free name** (`writeNew`): taken if any vault file has that base name (case-insensitive), then `-2` … `-100`;
  written with `flag: 'wx'`, so two uploads at once never overwrite each other. **Source folder** (`sourceFolder`):
  `Sources` matched case-insensitively; `new` claims `upload-<at>[-n]` with a non-recursive `mkdir`; a given name must
  exist directly in it and start with `upload-`.
- **Own folder** (`attachmentFolder`, pure): `dir/stem.md` is in its own folder when `base(dir)` equals `stem`
  (case-insensitive) or `stem` is `index`; otherwise it moves to `dir/stem/`.
- **Move** (`moveIntoOwnFolder`), all checks before the first write: `409 ai-busy` while a turn holds the lock;
  `409 folder-taken` when `dir/stem` is a file or `stem.md` exists in the folder; an existing folder in other case is
  used with its spelling. One ripgrep call (`filesMentioning`: the stem, with `%20`, and `encodeURI`'d) finds candidate
  pages; `rewriteLinks` (`packages/shared/src/relink.ts`, using the shared resolver moved from the web app) rewrites
  path-form wikilinks and Markdown links that resolve to the page, and relative links inside the moved page, skipping
  code blocks and spans; a percent-encoded link keeps its encoding. Then every touched page and the page itself are
  version-checked (`409 stale`), the attachment is written into the folder, the pages are rewritten, the page is
  renamed, its own text written, and its AI-touched mark renamed. `Vaults.afterRelinkScan` is a test seam between
  the scan and the checks.
- **Tidy after a turn** (`tidy-attachments.ts`, `Vaults.tidyAttachments`): `Running.edited` collects the turn's
  `file-edited` paths; `endTurn` runs the tidy on its `.md` pages and releases the turn lock only after it. Per
  picture (`MEDIA` kind `image`, linked via `linkedFiles`, not in `Sources/`) not in or below the own folder of a page
  showing it: owner = the showing page whose stem shares the longest prefix with the picture's name, then A–Z; a flat
  owner moves into `dir/stem/` (`attachmentFolder`, an existing folder in other case kept, `rewriteLinks`), then the
  picture moves there (`relinkFile`: path-form wikilinks and Markdown links to it; bare `![[name]]` stays). Planned on
  an in-memory copy, a taken name skips that picture; every page to rewrite is version-checked before the first
  rename. Moves and relinks are marked AI-touched (old and new paths); nothing in Conflict. The CLI
  `tidy-attachments-cli.ts` (`just tidy-attachments`) runs the same on a whole clone, dry run unless `--apply`.
- **Web, editor:** `NotePane.attach` filters non-uploadable files (one toast), `editor.track(at)` holds the cursor or
  drop point, and `store.uploadToNote` runs the files one after another: flush, pause autosave for that note,
  `prepare` (JPEG/HEIC: `createImageBitmap` with EXIF orientation → canvas ≤ 2048 px → JPEG 0.85, then APP1/APP13
  segments stripped, because WebKit's encoder writes an Exif block; else unchanged; HEIC that can't decode → error),
  50 MB refusal and 10 MB `confirm`, `api.upload` (a `Blob` body is sent as `application/octet-stream`), the path added
  to the file list at once, then the embed. A `moved` response runs `retarget`: the note's path, version and draft key
  follow, the route is replaced (no history entry), and the text becomes the server's (unedited) or the local draft
  through the same `rewriteLinks` (edited), pushed into the editor with `setDoc` before the embed goes in. The editor
  stays mounted (keyed by `openedAs`). If the editor is gone when an upload finishes, the embed is appended to the
  note's draft and saved.
- **Web, chat:** `ChatPane` keeps `{ chips: { path, version, mime, size }[], folder }` per chat in localStorage
  `karpathy.chips:<vault>:<chat>` (`lib/chips.ts`); chips whose file isn't in the first loaded file list are dropped.
  The first upload sends `source=new&at=`, later ones `source=<folder>`; ✕ is `DELETE /file` with the upload's version
  (the server removes the emptied folder). Send posts `{ text, attachments: paths }`. Chips and sent files render
  through `FileEmbed` → `mountEmbed` (an image through `/raw` and the object-URL cache, a PDF as a file card). The
  composer re-reads `GET /settings` when a chat opens.
- **Prompt:** `promptBody` = `{ text (≤ 100 000, may be empty with attachments), attachments? (≤ 5 paths), openPage? { path, mode, unsaved }, tabId?, timeZone?, locale? }` (`openPage`: see Custom tool `current_page`; not queued, written to the state file when the prompt is accepted; `tabId`, `timeZone`, `locale`: see [Browser tools and local time](#browser-tools-and-local-time), queued with the turn). The
  queued `Turn` keeps the paths (persisted in `config.json` `queued`, never bytes); an attachment-only prompt titles the
  chat with the first file name. At turn start `Vaults.checkAttachment` applies the raw-file rules, `isUploadable` and
  `MAX_ATTACHMENT_BYTES` (20 MB); a failure is a stream `error` and the turn ends before opencode. `PromptInput.files`
  become `FilePartInput { type: 'file', mime: uploadMime(path), filename: path, url: file:///vaults/<id>/<root>/<path> }`
  after the text part (left out when empty). opencode reads the bytes, stores them as a `data:` URL, normalizes images
  (≤ 2000 × 2000 px, 5 MB) and replaces what the model can't read with an "ERROR: Cannot read …" note.
- **History:** `mapPart` maps a `file` part with a `filename` to `ChatPart { type: 'file', path, mime }`; the `data:`
  URL never reaches the browser.
- **Model input:** `Harness.models()` returns `{ id, input: { image, pdf }, limit }` from opencode's
  `capabilities.input` and `limit.context` (missing or 0 → unknown); `GET`/`PATCH /settings` add `modelInput` for the current model, `null` when opencode doesn't
  answer within 3 s or doesn't list it.

## Attach preflight

`POST /vaults` (`Vaults.add`) checks a repo before anything is stored:

```mermaid
sequenceDiagram
  participant A as app.ts POST /vaults
  participant V as Vaults.add
  participant P as preflight()
  participant G as remote (GitHub or file://)
  A->>V: input (+ createFolders?)
  V->>V: repo format, refuseDuplicate, adding-set guard
  V->>P: repo, branch, root
  P->>G: clone --depth 1 --filter=blob:none --no-checkout -b branch (tmp dir, 60 s limit)
  alt clone fails
    P-->>V: GitError, mapped to 422 repo-unreachable
  end
  P->>P: ls-tree HEAD[:root] for the folder names
  P-->>V: rootExists, missing[] (subset of Sources, Wiki)
  P->>P: rm tmp dir (finally)
  alt root missing
    V-->>A: 422 root-missing
  else missing non-empty and not createFolders
    V-->>A: 409 missing-folders { missing }
  else
    V->>V: store vault (+ pendingFolders), startClone
    V-->>A: 202 Vault
  end
```

- The preflight clone is blobless, depth 1 and without checkout (commits and trees only, small even for media-heavy
  vaults), made in a random `pre-*` dir under `<vaultsDir>/.preflight/` on the vaults volume, and always removed.
  `Vaults.init()` removes `.preflight/` at startup (leftovers of a crash). The clone is killed after 60 s. It also
  works against `file://` remotes (setting `git.remote_base`, `file:///remotes/` in dev and prodtest) in
  tests and dev.
- **Folder check:** `git ls-tree HEAD[:<root>]`; only entries of type tree count, so a *file* named `Wiki` is missing.
  Names match case-insensitively; missing ones are created as `Sources/` / `Wiki/`. A root that isn't in the tree
  gives `rootExists: false`.
- **Concurrency guard:** an in-memory set of `repo|branch|root` keys whose add is in flight; a second add of the same key
  gets `409 duplicate`. It bounds parallel preflights per repo and closes the window between duplicate check and store.
- **Persisting:** only after the preflight passed. With `createFolders` and missing folders, the stored vault carries
  `pendingFolders`; when the clone has finished, `createFolders()` writes `<root>/<folder>/.gitkeep` (skipping a folder
  that exists after the clone, failing with "a file with that name exists" if a file blocks it) and then `cloned: true`
  is stored and `pendingFolders` removed. A restart mid-clone re-clones and still creates them. The writes are
  uncommitted changes (ADR 0001), outside the AI-touched set. Folders deleted between preflight and clone aren't
  re-checked.
- **Errors** (`HttpError` JSON `{error, code}`): `422 repo-unreachable` (message from `cloneErrorText`, redacted),
  `422 root-missing`, `409 missing-folders` (body adds `missing: string[]`), `409 duplicate`. `clone-failed` remains
  for failures after the preflight. `PATCH /vaults/:id` has no preflight.
- Messages from preflight and clone failures go through `redact()` before they are returned, logged or stored.

## GitHub token

- **Storage:** `ConfigData.githubToken`, a top-level key of `config.json` and deliberately not part of `Settings`,
  because `GET /settings` returns settings verbatim. `GitHubToken.current()` returns the stored token, else the
  deployment's `github_token` secret (settings `git.github_token`, a compose secret file named in `settings.json`)
  read at startup; `source()` is `settings | secret | none`; `clear()` falls back to the secret.
  Existing deployments therefore keep working unchanged.
- **Live getter:** `Vaults` gets `githubToken: () => string | undefined` instead of a startup string and calls it
  per git operation (clone, pull, push, preflight, access check), so a changed token applies to the next one, no restart.
- **Routes:**

  | Route | Body | Reply |
  |---|---|---|
  | `GET /settings`, `PATCH /settings` | `PATCH`: `{ commitReminderThreshold?, model?, webAccess? }`; `model: null` = back to the default | `SettingsView`: settings (`model` = the effective one) + `defaultModel`, `modelOverridden` ([Settings](#settings)) + `githubToken: { source, last4 \| null }` (last4 of the current token, stored or secret), never the plaintext, + `modelInput` ([Uploads](#uploads)) |
  | `PUT /settings/github-token` | `{ token }` (trimmed, 20–255 chars, no whitespace; else 400) | `204` |
  | `DELETE /settings/github-token` | | `204`; falls back to the secret |
  | `POST /settings/github-token/test` | `{ token? }`, else the current token | `200 TokenTest` |

  The token routes answer 404 when no `GitHubToken` is wired (tests that omit it).
- **Token test:** `TokenTest { ok, login?, scopes?, expiresAt?, error?, vaults: {id, repo, ok, error?}[] }`. Identity is
  `GET {GITHUB_API_BASE}/user` (default `https://api.github.com`, 10 s timeout; `X-OAuth-Scopes`,
  `github-authentication-token-expiration`); it reports 401 as "GitHub rejected the token (401)." and network failure as
  "GitHub is not reachable from the server right now.". In parallel, `Vaults.checkAccess` runs
  `git ls-remote --exit-code --heads <remote><repo>.git <branch>` per configured vault with the tested token, which
  proves repo access (a fine-grained token passes `/user` without it). Nothing is stored. API base (env
  `GITHUB_API_BASE`) and remote base (setting `git.remote_base`) come from the server, never from the request.
- **Redaction:** `GitHubToken` remembers every value seen since startup (secret, stored, every set and every tested
  token) and `redact()` masks each as `***`; `Vaults` redacts clone, preflight and access-check messages with it.

## File dates

`GET /vaults/:id/files` gives every file three optional dates (epoch ms), so the tree can sort by Last changed and
filter by author (#122):

| Field | Value |
|---|---|
| `modified` | uncommitted file: its mtime; else the committer time of its last commit |
| `ai` | the AI edit stamp |
| `human` | the newer of the human edit stamp and the last commit without the AI trailer |

```mermaid
flowchart LR
    subgraph Backend
      R["/files"] --> LF[Vaults.listFiles]
      LF --> LT[listTree]
      LF --> HD["Repo.fileHistory<br/>git log %ct + trailers,<br/>cached per HEAD + root"]
      LF --> CH[Repo.changes + stat]
      LF --> ES[(config.editStamps)]
      CHAT[file.edited → markAiTouched] -->|AI stamp| ES
      SAVE[save / new note / upload / link rewrite] -->|human stamp| ES
    end
    R --> W[web buildTree]
```

- **History pass:** one `git log -z --format=%x1e%ct%x1f%(trailers:key=Co-authored-by,valueonly) --name-only` over
  the vault root; the first commit seen per path is `last`, the first without the app agent's trailer `lastHuman`.
  Committer time, not author time: git log walks in that order, and a rebase keeps old author times. Cached in the
  vault runtime keyed by HEAD + root; concurrent listings share one run; a failed run is logged and not cached. Only
  `listFiles` adds dates: `listTree` stays date-free for search, uploads and relinking.
- **Stamps** follow the rules in [domain.md](domain.md) (Edit stamps). Human stamping is best-effort (a failed config
  write is logged, the save still succeeds). The cleanup of stamps of deleted files re-checks the disk and is skipped
  while the lock is `sync` or the vault is in Conflict.
- **Live updates:** while dates are in use (`usesDates`), the web refetches the listing 500 ms after a
  `files-changed` burst, once when `busy` leaves `turn` (the AI stamp can land after the watcher event), and when the
  user switches into such a view. Overlapping listings are numbered; only the newest sets the tree.
- **Known limits:** every new HEAD reruns the full history pass, also when sorting by name (fine for typical vault
  sizes; incremental `old..new` would fix it). Merge commits list no files, so a merge dates nothing. Stamps grow with
  every file the app ever wrote. Commit times are whole seconds, so a discard keeps a stamp less than 1 s newer than
  the last commit. A re-cloned vault starts without stamps.

## Admin mode {#admin-mode}

Admin mode (#150; vocabulary in [domain.md](domain.md#vocabulary), behaviour in
[functional.md](functional.md#admin-mode-150)) is a full-screen view that replaces the user-mode panes. It reuses the
existing settings, GitHub token, Instagram and vault routes unchanged and adds three read-only ones.

```mermaid
flowchart LR
  subgraph Web[apps/web]
    R["route.ts<br/>#admin/&lt;section&gt;"] --> S[Shell]
    S -->|user mode| UM[Sidebar · NotePane · ChatPane]
    S -->|admin mode| AM[AdminMode<br/>rail / list + section]
    AM --> G[General] & V[Vaults] & K[Secrets] & AI[AI] & US[Usage] & SV[Server]
    US & SV --> CH[Sparkline / StackedBars<br/>inline SVG]
  end
  subgraph BE[apps/backend]
    app[app.ts routes]
    se["settings.secrets<br/>from settings.json"]
    us[usage.ts]
    me[metrics.ts sampler]
  end
  subgraph OC[opencode]
    sess[sessions + messages]
  end
  AI -->|GET/PATCH /api/settings, as before| app
  K -->|GET /api/settings/secrets| app --> se
  US -->|GET /api/usage| app --> us --> sess
  SV -->|GET /api/metrics| app --> me
  me -->|30 s| proc["/proc · statfs · opencode health"]
  me --> f[("config volume<br/>metrics.jsonl")]
```

### Routing and the mode switch

- `lib/route.ts`: `#admin` and `#admin/<section>` never match a vault route (those start with `#/`). `parseRoute`
  returns `{ admin: AdminSection | '' | null, vault, path }`: `null` = user mode, `''` = `#admin` (the phone's section
  list; wider screens show `general`), an unknown section falls back to `general`.
- Store: `admin` is derived from the route (initial route and `popstate`). `openAdmin(section?, vaultId?)` saves the open
  note (`leave()`), closes the tablet overlay sidebar, pushes `#admin/<section>` (`#admin` on the phone) with history
  state `{ adminFrom: <user-mode hash>, adminDepth: 1 }` and sets `admin`. `syncRoute` does nothing while `admin` is set,
  so the user-mode route isn't rewritten underneath. `adminVault` carries the vault whose details Vaults opens first
  and is cleared once used (`clearAdminVault`).
- **History:** on wide screens and tablets `setAdminSection` replaces the entry, so one Back or **Done** leaves admin
  mode. On the phone the list → section step is a push (`adminDepth` + 1) and `adminUp` ("‹ Admin") goes back to the
  list (`history.back()`; with depth 1, a replace to `#admin`). `closeAdmin` (Done) does `history.go(-adminDepth)` to
  the remembered entry; after a reload straight into admin mode (no `adminFrom`) it replaces the entry with the last
  vault's route. `popstate` ignores a vault route whose vault no longer exists (Done after deleting the active vault)
  and re-syncs instead.
- `Shell` keeps `#app` mounted with the `hidden` attribute while `admin !== null` (no hidden-pane keyboard handler
  fires: the tablet overlay's Escape handler is off in admin mode), so a streaming reply, the vault event stream and
  the editor state survive.
- **Escape** (wide and tablet): `AdminMode` calls `closeAdmin` unless the event is handled, a `[aria-modal]` dialog is
  open, or the target is a text field (input, textarea, select, contenteditable). Not on the phone.
- **Focus:** the section heading (`h1`, `tabIndex=-1`) takes focus on mount and, on the phone, on each page change. On
  unmount the focus goes back to what was focused when admin mode opened (the gear or the vault menu button), else the
  gear, else the sidebar toggle, skipping elements that are gone, hidden or inert.

### Layout

| Width | Layout |
|---|---|
| wide (≥ 1024) | `nav.admin-rail` (232 px: brand + **ADMIN** pill, icon + label per section, footer text) on the left; the section on the right, at most 780 px wide (`.admin-inner`); header bar with the section title and **Done** |
| tablet (700–1023) | The same rail, 76 px: icon + short label |
| phone (≤ 699) | `#admin` is the section list (**ADMIN** pill, **Done**, large title, rows with icon, label and a one-line summary); a section has a header with "‹ Admin" and no Done. User mode's bottom tab bar is hidden with the rest of `#app` |

The phone list's summaries come from data at hand: the version (`/health`), the vault count, the secret count
(`secretsSummary`), the model and web switch (settings), tokens this week and cost (`/usage?days=7`) and CPU and disk
(`/metrics?range=1h`), each falling back to a static line while loading or on failure. The vault switcher lives only in
the user-mode sidebar. The components are in [Web app](#web-app-appsweb).

**Sections** (each saves only its own fields; `PATCH /settings` accepts partial bodies, `useSettingsSave` sends only
the section's):

| Section | Component | Source |
|---|---|---|
| General | `GeneralSection`: `CommitReminderForm`, `Versions` | `GET/PATCH /settings`, `/health` |
| Vaults | `VaultsSection`: list, details, add, help (the former dialog's body, no `Modal`) | `/vaults` |
| Secrets & keys | `SecretsSection`: `GitHubTokenForm`, `InstagramSettings`, `SecretTable` | `/settings/github-token`, `/ingest/instagram`, `GET /settings/secrets` |
| AI | `AiSection` → `AiForm`: model (free text), "Default: …" + **Use default**, **Title model** and **Vision model** the same way (`modelField`; the default is "the chat model" when `ai.title_model` is unset; the vision field only when `visionGateway` is set; a value equal to the default, or blank, is sent as `null` = default), Web access switch | `GET/PATCH /settings` |
| Usage | `UsageSection`: range 7 / 30 days, tiles, `StackedBars`, tables by model and vault | `GET /usage?days=` |
| Server | `ServerSection`: range 1 h / 24 h / 7 d, five `Sparkline` cards, status rows. Fetches at the report's `intervalS` (30 s until the first answer) while `document.hidden` is false and again on `visibilitychange`; a switch of range drops answers still in flight; an "updated N s ago" tick re-renders only its own span | `GET /metrics?range=` |

**Charts** (`components/charts/`): two inline-SVG components. `Sparkline` (one series, area + line, peak dot, crosshair and
tooltip on pointer move, min, max, latest and a "Show numbers" table) and `StackedBars` (one stack per day, drawn at the
wrapper's measured width through a `ResizeObserver` so labels keep their size on a phone; legend; tooltip; "Show numbers"
table). Series colours are the tokens `--series-1…3` (light and dark themes, checked for colour-vision deficiency; the
app's `--graph-*` colours failed that check). Values are text in text tokens, never in the series colour; every chart has a
tooltip and a table, so colour is never the only carrier.

### Secret status: rendered, not probed

The backend can't see most secrets (provider keys and the Exa key go only into `opencode.env`). The renderer
(`packages/settings/src/render.ts`, `secretManifest()`), which resolves every secret reference anyway, writes a manifest
into the backend's `settings.json`:

```json
"secrets": [
  { "name": "openrouter_api_key", "component": "opencode", "purpose": "Gateway openrouter API key", "optional": false, "set": true },
  { "name": "exa_api_key", "component": "opencode", "purpose": "Web search (Exa)", "optional": true, "set": false }
]
```

- One entry per secret name from `secretRefs(settings)` (so the active gateway's only); `set` = the secret's value was
  non-empty at render time; a name referenced twice keeps `optional` only if all references are optional.
- `purpose` and `component` come from the setting's path through the table `SECRET_INFO` (`gateways.<id>.api_key` →
  "Gateway `<id>` API key", `ai.web.exa_api_key` → "Web search (Exa)", `auth.bearer_token` → "App login token",
  `auth.opencode_password`, `git.github_token`, `git.author.*`, `proxy.dns.api_token`, `ingest.*`); any other path shows
  as its dotted path, component `backend`.
- `GET /api/settings/secrets` returns `{ secrets: SecretStatus[] }`. For `github_token` the backend overrides the rendered
  entry when `GitHubToken.source()` isn't `none`: `set: true`, `source` (`app` for a token set in the app, `deployment`
  for the secret) and `last4`. The deployment's rendered flag can't know the app's token.
- Trade-off: the status is as of the last render (a deployment, or `just dev up`), which is when secrets change, since the app
  never changes them. Probing opencode's environment at runtime would add a privileged call for static facts.

### Usage: `usage.ts`

```mermaid
sequenceDiagram
  participant W as Web
  participant A as app.ts
  participant U as UsageService
  participant H as Harness (opencode)
  W->>A: GET /api/usage?days=30
  A->>U: report(30)
  loop each vault directory (a failing one is left out)
    U->>H: usageSessions(dir) (all sessions, children too)
    U->>H: sessionUsage(dir, id) only if time.updated changed (cached)
  end
  U->>U: sum assistant messages in range by day (process TZ = setting timezone) × model × vault
  U-->>A: UsageReport
  A-->>W: 200 JSON
```

- `UsageRow` (flat, from `harness/map.ts`, the only code that knows opencode's message shape): `created`, `model`
  (`provider/model`), `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, `cost`, `completed`.
- `UsageService` caches a session's rows keyed by `time.updated` (like `context-cache.ts`), concurrency 4; a session
  whose last row isn't `completed` is read again next time, since a running turn doesn't move `time.updated`. Cached
  sessions that no longer exist are dropped. The first report after a start reads every session once.
- `UsageReport` (`packages/shared`): `{ days: ({date} & UsageSums)[], byModel, byVault: ({vault, name, chats} & UsageSums)[],
  total, costKnown }`; `UsageSums` = `input, output, reasoning, cacheRead, cacheWrite, cost`. `days` has one entry per day of
  the range, zeros included. `costKnown` is false when every cost is 0, and the UI hides the cost then. `chats` counts
  chats with usage in the range.
- `days` is 7 (default) or 30 (`UsageDays`); anything else is `400 bad-days`.

### Metrics: `metrics.ts`

- `MetricsSampler` is started in `main.ts` (`await start()`) and stopped on shutdown. `start()` primes the CPU reading,
  loads `metrics.jsonl` (an unreadable file logs a warning and starts empty; torn lines and samples older than 7 days
  are dropped and the file is rewritten) and takes the first sample at once; then every 30 s `sample()`:
  - CPU % from the difference of `os.cpus()` times between two samples (0 for the first without a previous one);
  - memory used = `os.totalmem() − os.freemem()`, refined by `MemAvailable` from `/proc/meminfo` when readable;
  - load from `os.loadavg()[0]`;
  - disk from `fs.statfs(VAULTS_DIR)` and `fs.statfs(CONFIG_DIR)`;
  - opencode up from `harness.health()` (the check `/api/health` also uses).
  In Docker without lxcfs, `/proc` and `os` report the host (the VM on a dev stack): the number wanted.
- **Store:** an in-memory array plus `CONFIG_DIR/metrics.jsonl`, mode 0600: every sample is appended (one line, ~150 bytes,
  ~20 000 lines in 7 days ≈ 3 MB); once an hour the file is rewritten atomically (temp file + rename) without old samples.
  Writes are serialized.
- `GET /api/metrics?range=1h|24h|7d` (`MetricsRange`, default `24h`; else `400 bad-range`) returns `MetricsReport`:
  `{ samples (≤ 240, bucket-averaged: CPU, memory used and load averaged, the rest from the bucket's last sample),
  latest, uptimeS, intervalS: 30 }`.
- The clock and the host readers are injected, so tests run without timers or a real host.

### Routes added to `app.ts`

| Route | Returns |
|---|---|
| `GET /api/settings/secrets` | `{ secrets: SecretStatus[] }` |
| `GET /api/usage?days=7\|30` | `UsageReport` (404 when no `UsageService` is wired) |
| `GET /api/metrics?range=1h\|24h\|7d` | `MetricsReport` (404 when no sampler is wired) |

All three sit behind the bearer token like every `/api` route and write nothing. The existing routes (`GET/PATCH
/settings`, `/settings/github-token`, `/ingest/instagram/*`, `/vaults`) are unchanged: admin mode reuses the forms that
call them.

### Decisions

| Decision | Chosen | Rejected and why |
|---|---|---|
| Mode switch | Hash route `#admin/<section>` | Store-only state: lost on reload, no Back. A router library: one more dependency for a single extra route. |
| Phone navigation | Section list → pushed section, Done only on the list | Bottom tabs: six sections don't fit next to user mode's tab bar. A horizontal tab strip hides sections off screen. |
| Charts | Own inline SVG | Recharts or uPlot: ≥ 40 kB for two chart types with ≤ 240 points. |
| Secret status | Rendered manifest | Runtime probe of opencode's environment: a new privileged opencode call for static facts. |
| Metrics source | Backend sampler + JSONL on the config volume | Beszel hub API: only on targets with monitoring, needs tailnet routing and hub credentials. Prometheus/Grafana: two more containers for one page. Beszel keeps the alerting. |
| Usage source | Aggregate opencode sessions | Own ledger: double bookkeeping, starts empty, needs hooks in every turn path. |
| Usage listing | A dedicated `usageSessions` (all sessions, children included) | The chat list (`roots`, newest 200) would undercount sub-agent and old sessions. |
| User and admin | UI split only; one token is both | Enforcing roles: a later change. Everything a user needs, vault switching included, stays in user mode. |

No data migration: `config.json` is unchanged and `metrics.jsonl` starts empty. A release must re-render the settings
for the `secrets` key (every deployment renders anyway; the backend tolerates its absence).

## Data

| Store | Content | Owner |
|---|---|---|
| Volume `vaults` → `/vaults/<id>` | Full git clone of each vault repo (no shallow or sparse clone). The notes themselves. | backend (git), opencode (file tools) |
| `<vault root>/Input/` (in the clone, tracked by git) | The ingest queue: one folder per input item, its `index.md` frontmatter holding the link state (`unresolved_links`, `resolved_links`, `failed_links`). | ingest service (creates, updates while links are open), AI (`move_to_sources`), user |
| Volume `ingest-state` → `/state` | gog's encrypted file keyring (Gmail OAuth client and refresh token), instascraper's session and activity ledger (`home/.config/instascraper/`), login staging dirs, ingest-email's rendered config and locks, the last-run file. Backed up with the server, not in git. | ingest service |
| `deploy/settings/*.yaml` (git) | The settings of every environment: central file, environment files; gitignored local overlays for dev and prodtest. Secret references only. | operator / developer |
| `tmp/settings/<env>/` (dev, prodtest), `/opt/karpathy.app/shared/` (target) | Rendered files: `.env` (compose), `opencode.env` (0600), `settings.json` (backend, mounted read-only at `/etc/karpathy/settings.json`), `ingest.json` (0600, the ingest service's profiles, mounted read-only at `/etc/ingest/config.json`). | renderer; Ansible on a target |
| Volume `config` → `/config/config.json` | `vaults` (config + `cloned` / `cloneError` / `pendingFolders`), `settings` (threshold, web access, `modelOverride`, `titleModelOverride` and `visionModelOverride` only while ≠ their defaults), `titleSuggestions` (per vault and chat, #148), `githubToken` (plaintext, if set in the app), `aiTouched`, `editStamps` (per vault and path: last AI / human write, epoch ms), `conflicts`, `queued` turns. | backend only |
| Volume `config` → `/config/metrics.jsonl` (0600) | The metrics history (#150): one JSON `MetricsSample` per line, every 30 s, 7 days (~3 MB); appended per sample, rewritten atomically once an hour and at start without old or torn lines. Not part of `config.json`. | backend only (opencode can't see the volume) |
| `/vaults/.preflight/` | Short-lived blobless clones of the attach preflight; emptied at startup. | backend |
| Volume `opencode-data` | opencode sessions = chat history, including attached files (base64, after opencode's resize), until the chat is deleted. | opencode |
| localStorage `karpathy.chips:<vault>:<chat>` | Unsent chat attachments (path, version, type, size) and their source folder. | web |
| Volume `caddy-data` | TLS certificates and keys. | proxy |
| Browser localStorage | Token, local drafts, tree expansion state, tree sort and filter (`karpathy.treeSort`, `karpathy.treeFilter`), main pane, mode preference (`karpathy.mode`), properties view (`karpathy.propsView`). | web |
| localStorage `karpathy.recentCommands.<vault>`, `karpathy.shownMoves` | The last 10 commands started in a vault (chip order); the agents moves already announced (last 50). | web |
| Backend memory | Per vault: the skill stamp of the last opencode refresh, the last agents move, the skill-link scan after it, running commit-message proposals, the pending browser calls. Lost on restart (the first check then refreshes). | backend |
| opencode image `/opt/opencode-config/opencode/` | Tools `open_note`, `current_page`, `open_url`, `suggest_next`, `look_at_image`, `user_location`, `save_url` and `move_to_sources`, plugin `known-url`, helpers, app skills (`skills/research/`). Read-only, from the release. | opencode |
| Volume `vaults` `/vaults/.browser-calls/<fileKey(chat)>/<fileKey(call)>.json` | The answer of a browser call, from the backend's write to the tool's read (deleted by the tool; removed at close, turn end, chat delete). Outside every clone, next to `.open-page`. | backend, opencode |
| sessionStorage `karpathy.tab` | The tab id (answering tab). | web |
| Browser memory | Object URLs of media (≤ 200 MB), places of notes seen this session. Lost on reload. | web |
| Service worker cache `vault-api` | Vault list, file trees, opened notes (for offline reading); cleared on 401. | web |

No database. Git is the source of truth for notes; GitHub is the sync hub.

## System boundaries

- **Exposed:** one HTTPS origin: the PWA plus `/api/*` (full route list in `apps/backend/src/app.ts`). Every `/api`
  route needs the bearer token; `/healthz` exists only inside the stack.
- **Consumed:** GitHub over HTTPS (clone, fetch, push), the opencode HTTP API and the ingest endpoint (`:8090`) on the
  internal network, the LLM provider APIs, Exa and public web pages (from opencode, through the egress proxy), the
  Gmail API, Instagram and the pages linked in mails (from the ingest service, through the egress proxy), and the DNS
  provider API (DNS-01, from the proxy only).

## External systems

| System | Used for | Status |
|---|---|---|
| GitHub | Vault repos; fine-grained token as an HTTP extra header, never in `.git/config`; `api.github.com/user` for the token test | in use |
| LLM providers (OpenRouter in production, any via opencode) | Model behind opencode, chosen as the environment's gateway in `deploy/settings/`; keys only in the rendered `opencode.env` | OpenRouter `z-ai/glm-5.3` on zero-data-retention hosts in production, dev, prodtest and every test (key in `deploy/secrets/openrouter_api_key`; CI secret `OPENROUTER_API_KEY`) |
| Exa | Web search backend (opencode `websearch`, MCP at `mcp.exa.ai`); optional `EXA_API_KEY`, else the anonymous, rate-limited endpoint | in use |
| Gmail (via `gog`) | The ingest profiles' labels: read, relabel; OAuth client and refresh token copied from the Mac by `just ingest-auth` | built; no profile enabled in production yet |
| Instagram (via instascraper / instagrapi) | Posts and Reels behind Instagram links in mails; password login from admin mode › Secrets & keys › Instagram | built; the real login not yet tried from the server |
| `tillg/ingest_email`, `tillg/instascraper` (GitHub) | Sources of the ingest image: the private ingest-email at a pinned commit (deploy key in CI), instascraper at a tag | in use |
| Let's Encrypt + GoDaddy DNS | Certificate for `app.karpathy.app` via DNS-01; the A record points at the server's tailnet IP. The apex and `www` point at GitHub Pages | in use |
| GitHub Pages | Hosts the website at `karpathy.app` (with GitHub's own Let's Encrypt certificate) | in use |
| ghcr.io | The app's release images (public) and opencode's base image | in use |
| Docker Hub | Base images; Beszel and Gatus | in use |
| Hetzner Cloud | The production server | in use |
| Tailscale | The only way into the server (SSH, app, monitoring UIs) | in use |
| ntfy.sh, healthchecks.io | Alert delivery to the phone; heartbeat dead-man's switch | in use |

## Infrastructure

- **Runtime = docker compose** in dev and prod (`deploy/compose.yml`). Services `proxy` (networks `edge` +
  `internal`), `backend` and `egress` (`internal` + `egress`), `opencode` and `ingest` (`internal` only, which is
  `internal: true`: no route out but the egress proxy); backend, opencode and ingest run as uid 1000; all with
  `cap_drop: [ALL]`, `no-new-privileges` and log rotation. Settings come rendered from `deploy/settings/`
  ([Settings](#settings)): compose interpolates `.env`, the backend reads `settings.json` (`SETTINGS_FILE`),
  opencode gets `opencode.env`, ingest `ingest.json`. Secrets are files mounted as compose secrets (`deploy/secrets/`
  in dev, `tmp/prodtest/secrets/` in prodtest, `shared/secrets/` on a target: `bearer_token`, `github_token`,
  `opencode_password`, `dns_api_token`, `gog_keyring_password`, `ingest_token`; the last two generated like the
  opencode password); provider keys, `EXA_API_KEY` and the web caps come from `opencode.env`.
- **Dev** (`compose.dev.yml`, `just dev up [N]`): numbered dev stacks side by side, one per checkout; stack N on
  https://localhost:80N0 with Caddy's internal CA, Vite with HMR (`web` service), bind-mounted sources, local bare
  repos as remotes (`dev.yaml`: `git.remote_base: file:///remotes/`), the production OpenRouter
  models (key from `deploy/secrets/openrouter_api_key`). The `ingest` service mounts the whole `vaults` volume,
  idles (no profiles in `dev.yaml`) and has the fake Instagram login; `just dev up` first runs
  `deploy/ingest/fetch-source.sh` for its build context. Details: [Dev stacks](#dev-stacks).
- **Local prod test** (`compose.prodtest.yml`, `just prodtest`): the prod images as project
  `karpathy-app-N-prodtest` on https://localhost:80N5, paired with the checkout's dev stack N (ingest idle, whole
  `vaults` volume, no fake login).
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, tests, web build, a compose config check, the ingest image
  (built from the private ingest-email, checked out with the read-only deploy key `INGEST_EMAIL_DEPLOY_KEY`) with its
  loop and endpoint tests, and `ansible-lint` + syntax checks of the playbook on every push and PR; weekly (and on
  demand) GitHub and LLM test suites. Fork and Dependabot PRs have no deploy key, so the ingest checkout fails there
  (#135).
- **Website** (`.github/workflows/pages.yml`): the site test, then `_site/` to GitHub Pages on every push to `main`
  that touches `site/`, `assets/icons/` or the app's stylesheet.
- **Releases and production:** a tag `vX.Y.Z` builds the images (amd64 + arm64) to GHCR; the Ansible playbook
  deploys a release to a **target**: `hetzner` (a
  Hetzner CPX22 reachable only over Tailscale, https://app.karpathy.app, running since 2026-10-02), with
  monitoring (Beszel, Gatus, a healthchecks.io heartbeat, alerts via ntfy). All of it:
  [deployment.md](deployment.md).

### Dev stacks {#dev-stacks}

Several agents develop on a dev host at once (the Mac or the remote dev host `karpathy-dev`,
[deployment.md](deployment.md#dev-server)), each in its own checkout (main clone or `.worktrees/<name>`), and each
needs a running stack for e2e tests and screenshots. Stack N (1–9) is compose project `karpathy-app-N` and owns the
port block 80N0–80N9 on that host (vocabulary: [domain.md](domain.md#development)). Everything below is the same on
both hosts; on Linux the Mac-only hints (restart Rancher, `brew install jq`, the Keychain) get Linux wording.

```mermaid
flowchart TD
    J["justfile<br/>dev · e2e · prodtest"] --> D["deploy/dev.sh"]
    J --> L
    D --> L["deploy/stack.sh<br/>resolve N · ownership · ports<br/>settings_render · settings_legacy_check"]
    L -->|"docker compose ls -a"| DK[(Docker daemon)]
    L -->|"read/write"| F["tmp/dev/stack<br/>(this and other worktrees)"]
    S["deploy/settings/<br/>settings.yaml + dev.yaml / prodtest.yaml<br/>+ local overlay"] --> L
    L -->|"render"| R["tmp/settings/dev/ · tmp/settings/prodtest/<br/>.env · opencode.env · settings.json"]
    R -->|"--env-file"| C
    R -->|"--env-file"| P
    D -->|"-p karpathy-app-N<br/>STACK · PROXY_PORT · BACKEND_PORT"| C["compose.yml + compose.dev.yml<br/>proxy :80N0 · backend 127.0.0.1:80N1"]
    J -->|"-p karpathy-app-N-prodtest<br/>PRODTEST_PORT"| P["compose.yml + compose.prodtest.yml<br/>proxy :80N5"]
    E["e2e/stack.ts"] -->|"read"| F
    E --> H["e2e/helpers.ts · global-setup.ts<br/>playwright.config.ts"]
```

- **Ports.** 80N0 is the proxy (the app over HTTPS; the Vite HMR socket goes through it, `HMR_CLIENT_PORT`), 80N1
  the backend's HTTP API on `127.0.0.1` for debugging without TLS (the backend can publish because it is also on
  the `egress` network), 80N5 the paired prodtest's proxy. 80N3 (opencode) and 80N4 (web) are reserved but never
  published: both sit only on the `internal: true` network. The rest is spare. On the remote dev host the SSH entry
  forwards 80N0 to the Mac; a VS Code Remote-SSH window leaves 80N0 alone (`.vscode/settings.json`) and forwards
  80N5 itself ([deployment.md](deployment.md#dev-server)).
- **`deploy/stack.sh`** (sourced; `jq`, `nc`) holds all of it; the compose files only interpolate `STACK`,
  `PROXY_PORT`, `BACKEND_PORT` and `PRODTEST_PORT`, and fail with a pointer to `just dev up` when they are unset
  (`:?`), so a raw `docker compose up` can't silently start a stack on a colliding port. `stack_resolve` picks N
  from the argument, then `$STACK`, then `tmp/dev/stack`, then (only for `up`) the first free stack. `stack_state`
  says `mine`, `free`, `other:<checkout>`, `orphan` or `port-busy`: the owner is the checkout in the project's
  Docker `ConfigFiles`, else another worktree (`git worktree list`) whose `tmp/dev/stack` claims N. The claim
  exists because `up --build` builds for minutes before `docker compose ls` lists the project; in the first
  acceptance run a second `up` 20 s later took the same stack. A same-second race between two `up`s is still
  possible (no lock).
- **`deploy/dev.sh up [N] | down | logs | ps | token | stacks`** runs
  `docker compose -p karpathy-app-N -f compose.yml -f compose.dev.yml` (`-p` overrides `name: karpathy-app`, so prod
  is untouched). `up` refuses a stack another checkout owns or whose ports a stranger holds (naming the owner and
  the first free stack), a second stack while this checkout holds one; it may take
  over an orphan, refuses a leftover hand-edited `deploy/.env` or `deploy/opencode.env` (`settings_legacy_check`:
  names their keys, never values, and where each goes now), creates the dev secrets, renders this checkout's
  `deploy/settings/` for `dev` into `tmp/settings/dev/` (`settings_render`; a missing secret or invalid setting stops
  it before compose), remembers N, and prints URL and
  token. Compose gets `--env-file ../tmp/settings/dev/.env` whenever that file exists, so a stack started before
  the settings can still go down. `just prodtest up` does the same for `prodtest` (secrets in
  `tmp/prodtest/secrets/`, plus any `deploy/secrets/*_api_key` for a hosted gateway). `down` keeps the
  volumes and releases the claim. `stacks` lists 1–9 with state, URL and owner, read-only. Volumes (`vaults`,
  `config`, `caddy-data`) are per project, so each stack has its own vaults and Caddy CA.
- **Images per stack.** The dev services reset `image:`, so compose names them `karpathy-app-N-<service>` and
  parallel builds never overwrite each other's images. Prodtest still uses `ghcr…:dev` tags, shared across
  checkouts (known risk).
- **Model.** No model server runs on the Mac or in a stack: dev and prodtest inherit production's OpenRouter models
  (`dev.yaml` / `prodtest.yaml` have no `ai` block). opencode reaches OpenRouter through the egress proxy like
  production; the key is `deploy/secrets/openrouter_api_key` (dev; `just prodtest` copies `deploy/secrets/*_api_key`).
  `dev.sh up` needs no model check or pull.
- **Host secrets.** Before rendering, `secrets_from_host` (`deploy/stack.sh`) copies each
  `~/.config/karpathy/secrets/*_api_key` missing or empty in the checkout's `deploy/secrets/` (mode 600); a key the
  checkout has wins. So a new worktree starts without copying keys. Without the OpenRouter key in either place,
  `dev.sh up` stops before the render and names both places. Copying (not reading through) keeps the render and the
  settings package unchanged.
- **Stack label.** The dev `web` service sets `VITE_STACK=N`; `brandName()` (`apps/web/src/lib/brand.ts`) makes the
  vault switcher's brand `karpathy #N`. The prod PWA is built without it and keeps `karpathy.app`, as do the token
  screen, the chat author line and `<title>`.
- **e2e target.** `e2e/stack.ts` is the TypeScript twin of `stack_resolve` without claiming: `E2E_BASE_URL` (a
  non-dev stack, with `E2E_BACKEND_CONTAINER`), then `STACK`, then `tmp/dev/stack` → `https://localhost:80N0` and
  container `karpathy-app-N-backend-1`; otherwise it throws "run just dev up". `just prodtest e2e` sets
  `E2E_BASE_URL=https://localhost:80N5`. The `justfile` never sets `E2E_BASE_URL` for dev stacks, so the dev-only
  specs (`attach.spec.ts`) run on every numbered stack.

## Settings {#settings}

Every app setting of every environment lives in `deploy/settings/` (issue #133; vocabulary:
[domain.md](domain.md#settings)). One renderer turns it into the files each component reads; dev scripts and Ansible
both call it.

```mermaid
flowchart TB
  subgraph Repo["Checkout"]
    SY["deploy/settings/settings.yaml<br/>+ ENV.yaml"]
    SL["ENV.local.yaml<br/>gitignored, dev/prodtest only"]
    PK["packages/settings<br/>load · merge · validate · render"]
  end
  subgraph Mac["Mac: dev / prodtest"]
    DS["dev.sh up · just prodtest up<br/>(settings_render)"] --> PK
    DSS[("deploy/secrets/ ·<br/>tmp/prodtest/secrets/")] --> PK
    PK --> DO["tmp/settings/ENV/<br/>.env · opencode.env · settings.json · ingest.json"]
    DO --> DC[docker compose]
  end
  subgraph Ctl["Mac: Ansible controller"]
    AV[("vault.yml")] -->|"vars/main.yml maps<br/>to secret names"| AR["role app<br/>render-settings.sh"]
    AR -->|"temp secret store (0700)"| PK
  end
  subgraph Host["Target host"]
    SH["shared/: .env + host facts ·<br/>opencode.env · settings.json · ingest.json · secrets/"] --> HC[docker compose]
  end
  SY --> PK
  SL -.-> PK
  PK -->|"rendered files"| AR
  AR -->|"copy, 0600"| SH
```

**Files.** `settings.yaml` (central: every setting with the shared value), one committed environment file each for
`dev`, `prodtest`, `test` and `hetzner` (only what differs), and the gitignored local overlays
`dev.local.yaml` / `prodtest.local.yaml`. The keys:

| Key | Holds | Overridden by |
|---|---|---|
| `ai.gateway`, `ai.model` | The gateway (a key of `gateways`) and the default model (`openrouter/z-ai/glm-5.3`) | — (`dev.yaml`, `prodtest.yaml` and `test.yaml` have no `ai` block: the production values) |
| `ai.title_model` | The model that writes chat titles (#148; optional, `<ai.gateway>/<model>`, listed under that gateway's `models` unless its kind is built in, like `ai.model`: opencode only has `ai.gateway`'s provider). Unset = the chat model in effect, an admin override of it included; the backend's `settings.json` then carries no `title_model`. `settings.yaml` has it as a commented line. | — |
| `ai.vision_model` | The vision model of `look_at_image` (required; `<gateway>/<model>` on any configured gateway, named by its own prefix — so switching only `ai.gateway` in an overlay keeps it valid; the gateway's kind must speak the OpenAI chat API): `openrouter/mistralai/mistral-medium-3-5` (Mistral Small 2603 was rate-limited upstream for the shared OpenRouter key, HTTP 429), with the same ZDR routing as the chat model under `gateways.openrouter.models`. `renderOpencodeEnv` writes `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY`, `VISION_REQUEST_OPTIONS` (the default model's `options`, merged into the request; kept for older images) and `VISION_MODEL_OPTIONS` (#148: JSON `{ "<model id>": options }` of every model of the vision gateway that has `options`, absent when none) into `opencode.env`. An admin can override it in admin mode › AI with another model of the same gateway (same base URL and key): the backend hands the model id to the tool as `/vaults/.vision.json`, and a model without an entry in `VISION_MODEL_OPTIONS` gets no request options. | — |
| `ai.web` | `access` (default of the Web access switch), `fetch_cap`, `search_cap` (20 each), `exa_api_key` (optional secret) | — |
| `auth` | `bearer_token`, `opencode_password` (secret references) | — |
| `git` | `remote_base` (`https://github.com/`), `author` (`name`, `email`), `github_token` (optional secret) | `dev`, `prodtest`: `file:///remotes/`; author per environment; `hetzner`: author as secrets `git_author_name` / `git_author_email` |
| `proxy` | `domain` (`localhost`), `tls` (`internal` \| `dns`), `dns.provider` (`godaddy`), `dns.api_token` (optional secret) | `hetzner`: `app.karpathy.app`, `dns`, token required |
| `timezone` | `Etc/UTC` | `hetzner`: `Europe/Berlin` |
| `commit_reminder_threshold` | Default of the commit reminder (4) | — |
| `files.visible_dot_dirs` | Dot-folders the file tree shows (`[.agents]`; names start with `.`, never `.git`) | — |
| `ingest` | `defaults` (ingest-email options: `max_per_poll` 20, `resolve_max_urls_per_mail` 5, `run_interval_s` 900) and `profiles` (`{}`: the loop idles). A profile: `vault` (backend vault id), optional `root`, `label`, `account` and `allowed_senders` (each may be a secret reference, so no personal data lands in the public repo), optional `settings` (ingest-email options) | only `hetzner` may set profiles (none yet; a test asserts `dev`, `prodtest` and `test` have none) |
| `gateways.<id>` | `kind`, `name`, `base_url`, `api_key`, `models` (opencode's per-model config, passed through): `openrouter` is the only gateway (built-in kind; `z-ai/glm-5.3` with its zero-data-retention provider routing); the `openai-compatible` kind (with `base_url`) stays in the schema, the harness being provider-agnostic | — |

**Load and validate** (`packages/settings`, plain TypeScript run with `tsx`, deps `yaml` and `zod`):

| Module | Does |
|---|---|
| `schema.ts` | Strict zod schema (`settingsSchema`, unknown keys fail), `partialSettingsSchema` for environment files (every key optional at any depth, secret references whole), `crossFieldErrors`: `ai.gateway` names a gateway; `ai.model` / `ai.title_model` (on `ai.gateway`) / `ai.vision_model` are `<gateway>/<model>` and, unless the kind is built in (`openrouter`, `anthropic`, `openai`), listed under the gateway's `models`; `proxy.tls: dns` needs `proxy.dns.api_token`. |
| `load.ts` | `environments(dir)`, `loadSettings(env, { dir, overlay })`: central file (complete) ← environment file (partial) ← local overlay (dev, prodtest; skipped with `overlay: false`; for other environments an error), merged map by map, validated complete again. Every error names the file (or `<env> (merged)`) and the YAML path. |
| `secrets.ts` | `secretRefs(settings)`: every reference with its path, from all settings except gateways other than the chosen one. `resolveSecrets(settings, store)`: reads `<store>/<name>`, trims one trailing newline, fails listing every missing non-optional secret. |
| `render.ts` | Pure functions, settings + resolved secrets in, file text out: `renderComposeEnv`, `renderOpencodeEnv`, `renderOpencodeProviders`, `renderBackendSettings`, `renderIngestConfig`. |
| `cli.ts` | `render <env> --out <dir> --secrets <dir> [--compose-dir <dir>]`, `show <env>` (effective settings, secrets as references), `get <env> <path>` (one value, e.g. CI's test models), `check` (every environment validates; in `just check` and CI), `--list-secrets <env>`; `--dir`, `--no-local`. `just settings …` runs it. |

**Rendered files:**

| File | Read by | Contents |
|---|---|---|
| `.env` (0600) | compose interpolation | `DOMAIN`, `TLS_MODE`, `DNS_PROVIDER`, `TZ`, `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (resolved), `GIT_REMOTE_BASE`, `DEFAULT_MODEL` (= `ai.model`), `SETTINGS_DIR` (dev, prodtest: the rendered dir relative to `deploy/`). A superset of the old Ansible `env.j2`, so an older release's `compose.yml` still finds every name (rollback); a target appends its host facts. |
| `opencode.env` (0600) | opencode (`env_file`) | The gateway's key under its provider's variable (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`; none for `openai-compatible`), `EXA_API_KEY` if set, `WEB_FETCH_CAP`, `WEB_SEARCH_CAP`, `OPENCODE_MODEL`, `OPENCODE_CONFIG_CONTENT` (`{ provider: { <gateway>: … } }`, merged after a vault's own config, see [opencode](#opencode-deployopencode)). Values compose's env-file parser reads back verbatim (`$` escaped). |
| `settings.json` | backend (`SETTINGS_FILE`) | Only what the backend needs: `auth`, `git` (remote base, resolved author, token), `ai` (`model`, `title_model` only when set, `vision_model` without its gateway prefix, `vision_gateway` = the vision model's gateway id, `web_access`; the last three optional in the backend's schema, so an older `settings.json` still loads: title falls back to the chat model, vision to none), `commit_reminder_threshold`, `files`, and `secrets` (#150: the secret manifest, names, purpose, optional and set as of the render, never a value; see [Admin mode](#admin-mode)). The compose secrets (`bearer_token`, `opencode_password`, `github_token`, `dns_api_token`) become `{ file: "/run/secrets/<name>" }`; any other reference is resolved inline. |
| `ingest.json` (0600) | ingest service (`/etc/ingest/config.json`) | `{ defaults, profiles }`; per profile `vault`, `root`, `label`, `account` and `allowed_senders` with their secrets resolved, and the profile's `settings` merged in. `run.sh` turns it into ingest-email's own config ([Ingest service](#ingest-service-deployingest)). |

**Compose.** `compose.yml` mounts `${SETTINGS_DIR:-.}/settings.json` read-only at `/etc/karpathy/settings.json`
(`create_host_path: false`: a missing render fails instead of leaving a directory) and sets `SETTINGS_FILE`; opencode
takes `env_file: ${SETTINGS_DIR:-.}/opencode.env` (optional, so `compose config` works without a render), ingest mounts
`${SETTINGS_DIR:-.}/ingest.json` read-only at `/etc/ingest/config.json` (also `create_host_path: false`). On a target
`SETTINGS_DIR` is unset and `shared/` is the project dir. No model or gateway literal is left in any compose file;
`compose.dev.yml` / `compose.prodtest.yml` keep only stack plumbing (ports, builds, source mounts). A dev stack renders the settings of the checkout it is
started in (main clone or worktree), with that checkout's overlay and secrets, so a branch that changes a setting runs
with it and parallel stacks never read each other's.

**Backend.** `settings.json` is parsed by the backend's own schema (`apps/backend/src/settings.ts`), not the
package's: the rendered shape differs (secrets as files) and the image needs no YAML code; a test in
`packages/settings` parses the renderer's output with it, so the two can't drift. Container wiring and build/deploy
facts stay env ([Backend](#backend-appsbackend)).

**Model default and override.** `ConfigStore.open(dir, { model, webAccess, commitReminderThreshold })` gets the
settings' values as defaults; there is no model literal in the code (`DEFAULT_SETTINGS.model` is `''`). In
`config.json` the model is stored only as `settings.modelOverride`, and only while it differs from the default:

| Event | Stored | Effective model |
|---|---|---|
| Admin saves with the default model in the field (or `PATCH model: null`) | no `modelOverride` | the default |
| Admin saves another model | `modelOverride` | the override |
| Deployment changes `ai.model` | unchanged | the new default, unless overridden |
| Old `config.json` with `settings.model` (before the settings) | on the next save: `modelOverride` only if ≠ the default | the stored model (an older Admin choice that differs from the new default stays in effect) |

`GET /api/settings` returns the effective `model`, `defaultModel` and `modelOverridden`; `PATCH` still checks a new
model against opencode's model list.

The title and vision model (#148) work the same way: `ConfigStore.open` also takes `titleModel` and `visionModel`
defaults (from `settings.json`; `''` when absent), and `config.json` holds `titleModelOverride` and
`visionModelOverride` only while they differ. `GET /api/settings` adds `titleModel`, `defaultTitleModel`,
`titleModelOverridden`, `visionModel`, `defaultVisionModel`, `visionModelOverridden` and `visionGateway`. `PATCH
/settings` takes `titleModel` (a string or `null`/blank = default) and checks it against opencode's model list like
`model` (`400 unknown-model`), and `visionModel` (string or `null`/blank = default), which must start with
`<visionGateway>/` and have a model part (`400 bad-vision-model`; it is not checked against the gateway). A `PATCH` that
touches `visionModel` rewrites `/vaults/.vision.json` ([Chat titles](#chat-titles)). The effective title model is
`titleModel || model`: unset follows the chat model, whatever is in effect. The threshold and Web access keep "stored wins": the settings give their value
until one is saved in the app.

**Test environment.** `deploy/settings/test.yaml` is empty: the tests' models are the production ones (OpenRouter).
`apps/backend/test/opencode-container.ts` (`pickTestModels(env, { openrouterKey })`, pure) works in this order: no
OpenRouter key (`OPENROUTER_API_KEY`, else `deploy/secrets/openrouter_api_key`) → the `@llm` tests throw
"no OpenRouter key: put it into deploy/secrets/openrouter_api_key (or OPENROUTER_API_KEY)" before any container
starts; else `LLM_TEST_MODEL` / `LLM_VISION_MODEL` if set (other OpenRouter models); else the models of
`loadSettings('test')`. The container gets the built-in `openrouter` provider with the ZDR routing of `settings.yaml`
(`renderOpencodeProviders`), the key passed by name (`-e OPENROUTER_API_KEY`, never on a command line) and traffic
through the egress proxy. The weekly CI job runs `npm run test:llm` with the secret `OPENROUTER_API_KEY`; the default
tier needs no key, network or model. Tests of the committed files use `overlay: false` / `--no-local`, so a developer's overlay never
changes a result.

**Ansible** renders a target's settings on the controller with the same CLI (`render-settings.sh`) and copies the
result to `shared/`: [deployment.md](deployment.md#settings-on-a-target).

## Design decisions

The ones that shape the whole system:

- **Agent harness = opencode** ([ADR 0002](../../docs/adr/0002-opencode-as-agent-harness.md)): neither loop nor
  tools nor skills are reimplemented; the backend only relays. The boundary is ACP-shaped so the harness stays
  swappable.
- **Editor = CodeMirror 6 on raw Markdown** ([ADR 0003](../../docs/adr/0003-codemirror-raw-markdown-editor.md)):
  lossless round trip, clean git diffs, no fight with the AI's raw edits.
- **Form edits go through the YAML CST and are refused when lossy**
  ([ADR 0005](../../docs/adr/0005-frontmatter-edits-through-the-yaml-cst.md)): `Document.toString()` moves comments
  and re-styles scalars; js-yaml has no CST. One invariant (`checkEdit`) guards every edit kind.
- **Vault = GitHub repo, sync = git:** the app holds no content of its own; Obsidian on other devices uses the same
  remote. One GitHub token for all vaults, editable in the app (the deployment secret is the fallback); if vaults
  ever span several owners, the follow-up is one token per owner, not per vault.
- **Checked attach:** a vault is stored only after a preflight (reachable, branch, root, `Sources/` + `Wiki/`), so a typo
  or a missing token scope never leaves a `clone-failed` vault behind. One endpoint answers `409` and is retried with
  `createFolders`, instead of a separate check endpoint that could go stale; git does the check, not the GitHub API,
  so it works against `file://` test remotes. Created folders are `.gitkeep` placeholders, uncommitted (ADR 0001); a
  visible `README.md` would look like a source to ingest skills.
- **Admin mode is a hash route over the same app, and observability is the backend's own** (#150, details and rejected
  alternatives in [Admin mode](#admin-mode)): `#admin/<section>` (reload, Back, bookmarks; no router library), own inline-SVG
  charts, the secret status rendered into `settings.json` instead of probed, a backend sampler with a JSONL history on
  the config volume instead of Beszel's API, and token usage aggregated from opencode's sessions instead of a ledger.
  The UI is split along the planned User and Admin roles; the one bearer token is both.
- **The user commits, the AI never does** ([ADR 0001](../../docs/adr/0001-user-triggered-commits.md)).
- **Explicit pull steps instead of `git pull --rebase --autostash`** (diagram in
  [domain.md](domain.md#pull-and-conflict)): unpushed commits are folded back with `reset --mixed`, never rebased, so no
  mid-rebase state can exist and stash pop is the only way into a conflict. If the remote history was replaced (no
  merge base), the pull resets onto the new upstream and everything local becomes uncommitted changes. During a
  conflict the clashing files hold the user's version, not `<<<<<<<` markers, which would leak into the editor,
  search and the AI. The unresolved paths are persisted in the config store, because after "keep theirs" on an
  untracked file git alone can't tell resolved from unresolved.
- **One in-memory lock per vault** (single backend process): saves and AI turns share it, git operations take it
  exclusively. A pull never runs during a turn, so a vault can't enter conflict mid-turn. The one exception is the
  background fetch: a shared `fetch` holder that is granted only when no exclusive operation holds or waits
  (`tryShared`). It touches only objects and `origin/<branch>`, so it may run next to saves and turns; exclusive would
  flicker "Syncing…", stall during turns and block saves behind a queued timer; no lock would race the pull's own
  fetch on the ref lock.
- **Incoming changes are counted in files on GitHub's side** (`diff --name-only HEAD...origin/<branch> -- <root>`),
  computed in `status()`, not stored; a timer fetches only vaults a browser has open; there is no automatic pull.
- **opencode runs the stock image without git.** Without git it can't detect the worktree, which is what confines
  its tools to a subfolder vault root and keeps session IDs stable (with git discovery, sessions vanished from the
  list once the project ID changed). If git ever goes into the image (e.g. for skill scripts), the git dirs must
  first move off the shared volume (`git clone --separate-git-dir`, a backend-only volume) and the confinement
  check must be re-run. Backend and opencode run as the same uid so files the AI writes stay committable.
- **Commit message proposals go through opencode** (agent `commit-message`, a throwaway session that is deleted
  afterwards), not a second LLM client, because only opencode holds provider keys.
- **Chat titles go through opencode too** (agent `chat-title`, #148), in a throwaway session of the vaults dir itself
  instead of a vault's dir: in a vault it showed as a "chat title" row in the chat list (sorted first) and a skill
  refresh could cut it off. The drift check is decided in code (`sameTopic`, word overlap), not by asking the model.
  The Admin's vision model reaches the tool as a file on the vaults volume, not as a restart of opencode (slow, cuts
  running turns) or a backend endpoint the tool calls (a new auth path).
- **Runtime = docker compose in dev and prod**, nothing native in dev. Rancher Desktop bind
  mounts deliver no inotify events, so the dev `web` and `backend` containers poll for source changes.
- **Numbered dev stacks, one scheme** (80N0, no stack 0 on 8443): two port schemes is what the hand-written
  `tmp/compose.*.yml` overrides showed going wrong (a missing `HMR_CLIENT_PORT`, shared image tags, commands
  hitting the wrong stack). The remembered stack per checkout beats `STACK=N` on every command, which is how agents
  end up on the wrong stack; a bare `up` takes the first free stack rather than always stack 1. Ownership comes from
  Docker plus the other worktrees' claims, not a separate registry that could go stale.
- **Every model on OpenRouter, no local model server**: a local model was weak (three `@llm` tests
  failed on it), CPU-only in the Rancher VM or a host dependency on the Mac's GPU, and it needed a relay per stack
  to keep its admin API away from a prompt-injected AI. One mental model: tests run what ships; cost is a key and
  per-token spend (the budget is fine). Offline lifecycle tests use `DEAD_MODEL` instead of a model.
- **One settings directory, rendered for each component** (#133): before it, the model alone sat in nine places
  (compose defaults and overrides, `group_vars`, `env.j2`, the dev opencode config fixture, the config store) and a persisted Admin
  choice silently pinned it. A central file plus sparse environment files shows what makes an environment different;
  secrets are references because the repo is public and the targets need their vault anyway. Components that read
  only their own formats (compose, opencode, Caddy; on a target a release's fixed `compose.yml`) get rendered files
  from one TypeScript renderer that dev, CI and Ansible share, instead of Jinja templates repeating merge and
  validation. Container wiring (`PORT`, `VAULTS_DIR`, …) stays env: fixed per image, never chosen per environment.
  Policy (opencode permissions, egress rules, Caddy headers) stays baked into the images. The model default lives in
  the settings and the Admin's choice is an override stored only while it differs, so a changed default reaches
  every installation that didn't pick its own.
- **Read-only git commands run with `GIT_OPTIONAL_LOCKS=0`**: status polling raced with Discard on `index.lock`.
- **The AI shows notes through a server-side, check-only tool** (`open_note`), not a client-side function: the agent
  loop runs in opencode on the server, so the browser can't execute tools. The UI learns about it from the existing
  tool part (`ToolCall.opens`), not a new event type, so replay and reattach follow the same rules as every chip. The
  tool is baked into the image; a backend MCP endpoint was rejected because it would need an auth exemption or the
  bearer token inside opencode.
- **Commands are skills, sent as prompts** ([ADR 0004](../../docs/adr/0004-commands-as-prompts-not-command-endpoint.md)):
  opencode's command endpoint runs shell snippets from skill files with no permission check and can't carry the per-turn
  tools map, so the skill text goes as a hidden (`synthetic`) part of the normal `promptAsync` call and keeps every guard. A
  hidden part with "call the skill tool" was rejected (small models often don't), and so was scanning `.claude/skills` in the
  backend (re-implements opencode's discovery).
- **Vault skill beats app skill, decided by the backend:** opencode's pick on a clash isn't stable, so the backend reads the
  vault's `SKILL.md` itself for the list and for command turns.
- **The vault follows the `.agents` standard,** enforced with the narrow `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, not the broad
  flag, which would also drop `CLAUDE.md` for vaults not yet moved. Palette and the AI's `skill` tool then see the same
  folder. The app moves vaults there automatically (uncommitted, never overwriting, notice + review) and keeps Claude Code on
  the Mac working with `CLAUDE.md` = `@AGENTS.md` and a staged symlink `.claude/skills → ../.agents/skills`. Imports are pasted
  into `AGENTS.md` because opencode doesn't expand `@path`. Only `.claude/` is migrated.
- **A chip fills the composer and sends nothing:** a bare `/research` would get its topic in a later plain turn, outside the
  command.
- **Research is a skill in the image, not backend code,** and its plan step is an instruction, not a rule: the plan is better
  after a little scouting, and the web caps stay the hard bound. Rejected: a backend rule for a tool-less plan turn, an
  approval dialog (needs `ask`), a background job, GPT Researcher as an MCP server (a new service and outbound path).
- **`open_url` is a check-only server tool; the tab opens on the user's tap** (browsers block `window.open` without one).
  It works with Web access off, since the server makes no request.
- **`save_url` is a custom tool, not `bash` + `curl`.** `bash` stays denied, and a tool can enforce what a shell can't: a new
  file only, media/PDF extensions, inside the vault, a size cap, the known-URL rule. The proxy is passed explicitly, not left to
  `HTTP(S)_PROXY`, and each redirect hop is checked against `NO_PROXY`, which Bun honors even for an explicit proxy: a direct
  fetch from the opencode container can reach `backend` and `opencode` on the compose network.
  The AI then embeds the file by editing the note itself, so there is no second write path into notes.
- **Ingest = a queue folder plus a deterministic service plus a vault skill** (#131): whatever is in `Input/` is new,
  instead of guessing "new" from uncited sources and the wiki log. `Input/` is capitalised like `Sources/` and `Wiki/`
  and tracked by git, so the queue is backed up, visible and can be fed from the Mac; the cost is that waiting items
  show in Changes and are committed twice. Fetching runs on the server so nothing needs the Mac; interpreting stays a
  vault skill, so the app holds no ingest logic and the same skill runs in Claude Code.
- **The ingest service reuses ingest-email in its own container,** behind the egress proxy and without app tokens
  (see [Ingest service](#ingest-service-deployingest)). Its source comes in as a named build context, checked out with
  a read-only deploy key in CI, not a personal token (one repo, read-only) and not by making the repo public.
- **The input count is computed in the browser** from the live tree; a backend field would duplicate it. It counts every
  item, ready or not: one number, the queue length.
- **One tap sends a bare `/ingest`;** batching is the skill's job. A long ingest holds the vault lock like any turn;
  Stop is the user's control, and the skill's item-by-item order keeps Stop consistent.
- **The ingest service writes without the backend's lock,** using only atomic renames and only items with open links;
  the pull leaves `Input/` out of its stash so the bind mount and the service's writes survive a pull.
- **Instagram is connected from the browser, logged in on the server:** the cookie can't be read cross-origin and
  Instagram has no reading API; a server-minted session is also the one Instagram sees in use. The status is read from
  the vaults' items, not from a status file in ingest-email, so the pinned ingest-email works as is.
- **Only production gets real ingest profiles;** any other stack with a real label would take mails before production
  sees them.
- **Swapping main and side column is CSS only** (`order`/`flex`): a keyed reorder in JSX keeps component state but
  moves DOM nodes, which drops keyboard focus and resets scroll positions. Cost: Tab order doesn't follow the visual
  order when the chat is in main.
- **Web access = opencode's own `websearch` + `webfetch` plus three guards** (known-URL plugin, egress proxy, server
  password), not provider server tools (one vendor, against ADR 0002) or own tools. URL permission patterns can't stop
  SSRF (webfetch follows redirects), so a network-level proxy does; the plugin client needs direct loopback, so the
  password is required. One global switch, on by default, fail-closed in the config. Search is pinned to Exa (one
  known recipient). Fetched pages live only in the chat; archiving a source is the ingest skill's job.
- **Media reaches the page as authed `fetch` → `blob:` object URL.** A token in the query string would land in proxy
  logs and history; cookie auth would add a second scheme and a CSRF surface; a service worker injecting the header
  could stream and seek but can't reach the token in page `localStorage`. Cost: whole files are fetched before they
  show, bounded by the 50 MB preview limit and the 200 MB cache budget.
- **Media embeds in Write mode are block widgets below the line**, not a replacement of the `![[…]]` text: the text
  stays editable and the round trip lossless, without cursor-in/out handling that is awkward on touch.
- **PDFs open in a new tab, not inline:** inline needs `frame-src blob:` and shows poorly on iOS and Android; pdf.js
  would add about 1 MB and its own UI and security updates.
- **Remote images stay blocked** (`img-src` has no `https:`): notes from git, web clips and AI ingests could otherwise
  phone home.
- **The mode preference is per browser in localStorage**, not per vault, note or server: it's a device habit (read on
  the phone, write on the Mac).
- **Uploads: a binary `POST /raw` body, the server picks folder and name.** Rejected: base64 JSON (the 10 MB limit, a
  third more bytes), multipart (a parser dependency for one file), `PUT /raw?path=` (the server decides the final
  path). The server owns the `-2` suffix and the `wx` write, so concurrent uploads can't race each other.
- **A page with attachments gets its own folder; Obsidian's settings aren't read.** The vaults already keep pages
  with images as `Wiki/<slug>/<slug>.md` and gitignore `.obsidian/`, so the clones never see `app.json`. A flat page
  moves on its first upload, with path-form links rewritten (about 1 in 20 links in the vaults is path-form and
  would break in Obsidian, whose resolver needs the path to end with the link). Bare links are left alone.
- **Upload names are unique in the whole vault**, so the bare `![[name]]` resolves to the new file in every tool,
  not only in those that prefer the note's folder.
- **Photos are prepared in the browser** (2048 px, JPEG 0.85, metadata dropped): no native image library in the
  backend, the full photo never crosses the phone's network, GPS never reaches git or the provider. HEIC is converted
  by iOS (an explicit `accept` list without HEIC, JPEG first) or by Safari's decoder; the server refuses HEIC.
- **Chat attachments are vault files first,** sent as `file:` parts: the queue survives a restart without bytes, the
  AI can re-read and link the file, a PDF in `Sources/` stays ingestible. The backend checks the path, because
  opencode reads a `file:` URL without its own directory check. A text-only model gets opencode's "cannot read" note
  rather than us filtering the part.
- **File kind by name, after the media table** (#126): "note" means Markdown; every other text file is an HTML page
  or a code file, with one language dependency (`@codemirror/language-data`, lazy per language) instead of a second
  highlighter. Predictable from what the user sees; content sniffing was dropped.
- **HTML pages render inert** (#126): sanitized, vault resources inlined, in a frame without `allow-scripts` or
  `allow-same-origin`. Scripts would need vault pages on a separate origin (own hostname, certificate, token
  handling): a later change. Rendering into the app's DOM was dropped (CSS leaks both ways), as was serving the page
  from `/raw` in the frame (the bearer token can't ride on a frame `src`).
- **Emails parse in the browser** (#166): postal-mime on bytes the view already has; no backend route and no server
  parsing of untrusted mail. The HTML body reuses the HTML-page path (`preparePage` + `SANDBOX`) rather than a second
  sanitizer. Read-only, no source view (editing MIME by hand breaks mails); `.eml` decided before the text check, as
  mails with Latin-1 parts are common. Rejected: mailparser (Node only), an own MIME parser, `message/rfc822` from
  `/raw` (nothing the view needs).
- **The back arrow is browser Back** (#139): history entries carry `{ prev }`, the arrow calls `history.back()`; an
  in-app stack would drift from browser Back, swipe-back and reloads (the bugs of #5).
- **Context usage = the last reply's tokens against its model's window from the provider config** (#140): no
  per-model table in the app (provider-agnostic), no sum of replies (overcounts), not the default model's window (a
  chat may have run on another model). The chat list fetches last messages lazily per changed session rather than
  tracking only the stream, so chats from before a backend start or another device show too.

## Testing

- **Email tests** (#166): synthetic fixtures `apps/web/src/lib/fixtures/*.eml` (alternative, related with a `cid:`
  PNG + PDF + remote image, plain, Latin-1 not UTF-8; `.gitattributes` `*.eml -text` keeps their CRLF), always read
  as bytes. Units `lang.test.ts` (kind rows), `email.test.ts` (headers, inline vs attachment, decoded `cid:`, CSS /
  oversized / forwarded parts, Latin-1, garbage refused), `EmailView.test.tsx` (fake API: no `/raw` for UTF-8,
  HEAD + `/raw` for binary, size limit on both paths, sandbox, `data:` image, attachment buttons, error state),
  `html-page.test.ts` (`<area>` and `#` links); e2e `email.spec.ts` (desktop, WebKit, `@iphone`; `cspGuard`;
  download, Latin-1, search hit, old draft dropped).
- **Text files, back arrow, chat context tests** (#126, #139, #140): units `lang.test.ts` (the kind table, languages,
  plain fallback), `Editor.test.tsx` (code kind: no wikilinks, highlighting), `html-page.test.ts` (sanitizing, CSS and
  image inlining, remote → link, link rewriting, `../` outside the vault), `HtmlView.test.tsx`, `store.test.tsx`
  (new text files, `prev`/`canGoBack`, `pageMode`), `route.test.ts`, `time.test.ts`, `ContextMeter.test.tsx`,
  `chat.test.ts`; backend `harness-map.test.ts` (tokens → used, model limits) and `context-cache.test.ts` (fetch only
  changed sessions, last entry, sort; a plain `fetchLast`, no SDK mock); e2e `code-files.spec.ts`,
  `html-pages.spec.ts` (sandbox, no script run, `cspGuard`), `back-arrow.spec.ts` (desktop and `@iphone`) and
  `chat-context.spec.ts` (`n / 16,384` with the dev model).
- **Outline and properties tests:** units `outline.test.ts`, `noteinfo.test.ts`, `schema.test.ts`,
  `frontmatter.test.ts` (incl. the demo vault's 212 `Wiki/` frontmatters set-and-back, add-and-remove, byte for byte)
  and `frontmatter.prop.test.ts` (fast-check, 1,000 runs per property: stringify identity, every edit refused or
  byte-identical outside the edited pair, set-back and add/remove identity, refusals under 5 %); e2e
  `outline.spec.ts` (both modes, jumps, current section, sheet/panel rules, note info, selection, no recompute while
  typing in a 5,000-heading note) and `properties.spec.ts` (form/YAML, one field = one line, undo, CRLF, chips,
  stale edits, hits in the frontmatter, the guard, schema file, + Property, phone, read-only); a11y scans with both open.
- **Incoming-changes tests:** `repo.test.ts` (count in files, GitHub's side only, root pathspec, no merge base),
  `lock.test.ts` (`tryShared` never queues), `api.test.ts` (fetch schedule with a short `fetchIntervalMs`, joined
  fetches, `pullError`, `POST /pull` incl. 423 and a conflict), `incoming.test.ts` (the AI-turn rule, which the e2e
  stack can't hold without a real LLM), e2e `remote-changes.spec.ts` (an Obsidian push shows, one tap pulls, open-note
  bar, phone badge).
- **File date tests:** `api.test.ts` "file dates" (commit vs mtime, committer not author time, human vs AI trailer,
  HEAD and root changes, vault roots) and "edit stamps" (restart, commit, AI vs human, discard/move/removal, deleted
  files, rewritten links); the unpushed-AI-commit fold in "git API"; `tree.test.ts` (sort both ways, folder rank,
  undated last, filter, the filter's date, preferences); e2e `tree-sort.spec.ts` (menus, live re-sort, hidden open
  note, `@llm` AI filter) and the menus in `a11y.spec.ts`; `@llm` `chat.llm.test.ts` (a real turn stamps `ai`).
- **No mocks:** integration tests use real git (local bare repos as remotes, a second clone plays "Obsidian") and
  the real opencode container — built from `deploy/opencode/Dockerfile` (`kai-test-opencode`), so tests load the same
  config and tools as prod; CI builds it once before `npm test`. A scripted fake LLM provider would count as a mock.
  The one agreed exception is the Instagram login (a real one is a flag-risk event and needs a phone): a fake
  instascraper login in `test_server.py`, a local HTTP stand-in for the ingest service in `ingest-routes.test.ts`, and
  the dev-only fake login mode for e2e.
- **Three tiers:** *default* (`npm test`, every push: unit + git integration + opencode lifecycle, no secrets; chat
  tests use `DEAD_MODEL`, a model on a test-only provider that answers 401 (opencode's own port), so turns fail fast and the lifecycle is tested offline without an LLM, a key or a network),
  *`@github`* (weekly + locally: against the private throwaway repo `tillg/karpathy-app-test-vault`, pushing only
  to temporary `test-<ts>` branches) and *`@llm`* (weekly + locally: real model turns).
- **Attach and token tests:** test remotes carry `Sources/` and `Wiki/` (backend `makeRemote`, e2e `make-vault.py`, the
  GitHub test vault), so ordinary tests attach without a `409`; preflight tests opt out (`structure: false`). Token
  storage, precedence, masking and redaction run in the default tier; the `/user` identity check and a token changed
  at runtime need real GitHub (`@github`), because `file://` remotes never send the auth header.
- **Web access tests:** default tier: known-URL units, Basic auth (401 without the password), the session permission
  set by the `tools` map, settings round-trip, mapping on captured fixtures; `egress.test.ts` `docker exec`s into a
  test opencode container and proves loopback without the password, the backend stand-in, `169.254.169.254` and a
  redirect to an internal URL fail, and a public URL works (skipped offline). `@llm`: one search, one fetch of a
  pasted URL, one constructed URL refused.
- **`@llm` rules:** prompts name the tool explicitly; assertions check tool events and the file system, never answer
  text; a turn without any tool call fails as *inconclusive*, not as passed; at most one retry.
- **Model in dev and tests:** dev, prodtest, e2e and the `@llm` tests all run the production OpenRouter models (see
  Test environment). `DEAD_MODEL = 'dead/kai-no-such-model'` (`DEAD_MODEL_2` likewise, with image input declared, so
  `modelInput` is tested without a model run) sits on a test-only `openai-compatible` provider `dead` in the test
  container's config (never in `deploy/settings`) whose base URL is opencode's own port,
  `http://127.0.0.1:4096/no-such-provider/v1`: opencode's server answers 401, which the AI SDK treats as
  non-retryable, so a turn fails within about a second, offline, with no key. The vault-can't-override and
  websearch-offered tests use the `dead` provider; fixtures and unit tests use `openrouter/…` ids.
- **Chat title tests** (#148): default tier: settings schema and render (`title_model`, `VISION_MODEL_OPTIONS`),
  `config-store.test.ts` (overrides, suggestions), `chat-title.test.ts` (fake harness: turn 2, drift with and without a
  shared word, other turns nothing, failure and timeout keep the title, cleaning, rename during the job, session deleted
  before the event, the `chat-title` agent denies every tool), `vision-model.test.ts`, `look-at-image-tool.test.ts` (override
  file, options map), `api.test.ts` / `chat.test.ts` (settings validation, routes, event), `Admin` and `ChatPane`
  component tests; `@llm` (`chat-title.llm.test.ts`): after two turns a short title that isn't the first prompt, after
  ten turns that left the topic a suggestion; e2e: Admin AI fields save and reset, `@llm` generated title (list has one
  row before and after).
- **Command and move tests:** default tier: `command.test.ts` (parse, expand; a `` !`id -u` `` stays literal),
  `agents-standard.test.ts` (scan, move, convert, clashes, inlined imports, the staged link), `api.test.ts` (the move on open and pull, the commit carrying a real symlink, the
  `agents-move` event), `harness-map.test.ts`, `chat.test.ts` (command turns, skill refresh), `known-url.test.ts` (`guardWebCall`),
  `save-url.test.ts` (against a real local HTTP server), `opencode-tools.test.ts` (`open_url`, and `save_url` incl. proxy enforcement: loopback variants, `NO_PROXY` hosts and an internal host refused, with Bun itself as the oracle, against the real container), web `commands.test.ts`; `@llm`: `/query`, the research
  plan and run turns, resume, a link offer; e2e `commands.spec.ts` (palette, chips, move notice) and `ai-open-url.spec.ts`.
- **Upload tests:** default tier: the upload route, collisions, refusals, the move and its link rewrite, source
  folders, prompts with attachments (a stored opencode user message with a file part is the
  `opencode-user-file.json` fixture); `@llm`: a vision model reads `word.png` ("KIWI"). e2e `attach.spec.ts`: photo
  preparation (dev stack only: it imports `/src/lib/attach.ts` from Vite), the editor button, a move the editor
  follows, drop (Chromium only: a synthesized file drop isn't reliable in WebKit), visibility, growth warning, chat
  chips, the phone layout. Uploads are held with `page.route` (not answered), which needs `serviceWorkers: 'block'`.
  The chat test sends a real prompt to the dev stack's model.
- **Ingest tests:** web units `tree.test.ts` (`inputCount`) and `reminder.test.ts`; web component tests with
  `@testing-library/react` in jsdom (`// @vitest-environment jsdom` per file, vitest includes `.tsx`;
  `src/test/fake-api.tsx` renders the real `AppProvider` against a fake `fetch` at the HTTP boundary):
  `FileTree.test.tsx` (badge, button only with an `ingest` command, disabled states), `Shell.test.tsx` (phone tab count),
  `store.test.tsx` (`ingestNow` creates a chat, then sends `/ingest`), `InstagramSettings.test.tsx` (code step,
  errors, Reconnect). Backend: `move-to-sources.test.ts` (real temp vault: moves with media, every refusal),
  `opencode-tools.test.ts` (`move_to_sources` in agent `vault`, absent in `vault-readonly`), `harness-map.test.ts`
  (both paths of a move), `api.test.ts` (`inputChangedCount`), `repo.test.ts` (a pull keeps `Input/` the same
directory with its items), `ingest-routes.test.ts`
  (bearer, zod, forwarding with the token to a real local HTTP stand-in for the service, 503, 401 → 502, no password in
  the log), `ingest-egress.test.ts` (a real ingest + egress container pair: the backend stand-in,
  `169.254.169.254` and a private IP refused, a public URL through the proxy, httpx and `gog` honouring
  `HTTPS_PROXY`), `plan-gaps.test.ts` (five services, ingest publishes nothing and has exactly its two secrets).
  Ingest service: `deploy/ingest/run.test.sh` (the loop against a fake `ingest-email` on `PATH`: fetch and resolve
  cadence, last-run file also during a long call, skipped vault, `.tmp-*` cleanup, the rendered ingest-email config,
  idle without profiles), `compose.test.sh`
  (`docker compose config` for prod, dev and prodtest: internal network only, proxy env, healthcheck, own secrets only,
  named build context, fake login only in dev), `server.test.sh` (pytest `test_server.py` in the image's test stage,
  with a fake instascraper login: token, code step, 0600 session and no password under `/state`, superseded logins,
  code timeout, status never logging in); all in `just check`. Settings: `render.test.ts` (`ingest.json`),
  `repo-settings.test.ts` (no profiles outside `hetzner`). e2e: `ingest.spec.ts` (an item written into `Input/` shows
  the badge; Ingest sends `/ingest` in a new chat and is disabled while the turn runs; no button without the skill;
  the stub skill arrives by push and pull, as a real skill does; `@llm`: the full move) and `instagram.spec.ts` (wrong
  password, connect with a code, disconnect, against the dev stack's fake login); the `@llm` and Instagram cases run in
  the `desktop` project only. The real Instagram login is never
  called from a test (flag risk, 2FA).
- **Dev stack tests** (in `just check`): `deploy/stack.test.sh` (ports, owner from `compose ls` JSON, states,
  resolution order, claims, refusals) and `e2e/stack.unit.ts` (the e2e target resolution).
- **Settings tests:** `packages/settings` units: merge, schema and cross-field errors with file and YAML path, secret
  resolution, each renderer (golden strings: the OpenRouter opencode config block (the central fixture in `test/helpers.ts` also has a neutral
  `openai-compatible` gateway), a `.env` whose keys ⊇ the old `env.j2`'s, `settings.json` parsed by the backend's schema), the CLI, and the committed
  files (five environments, today's effective values, environment files hold only differences, model literals only
  in `deploy/settings/`). `just settings check` in `just check` and CI. `stack.test.sh`: compose config with a render
  has no model literal and mounts the rendered files, `settings_render` and `settings_legacy_check` (and that `dev.sh`
  and `just prodtest` call them), `render-settings.sh`, every secret a target uses has a source in role `app`, and
  `compose.target.yml` has no model relay. A guard test in `repo-settings.test.ts` forbids the name of the removed
  local model server (pattern built from pieces) in tracked files outside `specs/research/**` and `DECISIONS.md`. Backend: `settings.test.ts`
  (`loadBackendSettings`), `config-store.test.ts` (override only while ≠ default, legacy model), `api.test.ts`
  (`defaultModel`, `modelOverridden`, `PATCH model: null`); e2e `admin.spec.ts` (the Default line, override, Use
  default, persisted after a reload).
- **e2e:** Playwright against the checkout's own dev stack N (`e2e/stack.ts`), or the prod images via
  `E2E_BASE_URL` (`just prodtest e2e`); every test fails on a
  CSP violation (so the media specs prove the prod `media-src` only when run with `just prodtest e2e`; the dev proxy
  sets no CSP). Media fixtures are tiny real files in `e2e/fixtures/media/`. Offline e2e in WebKit is skipped (Playwright's offline WebKit fails even service-worker-served
  requests).
