---
title: "Domain: karpathy.app"
created: 2026-10-01
edited: 2026-10-04
---

# Domain: karpathy.app

As of 2026-10-02 (MVP milestone M4 implemented, deployed to production; milestones in
[functional.md](functional.md#scope)). The canonical glossary for the team is
[`CONTEXT.md`](../../CONTEXT.md); this page restates it with the rules the code enforces and adds the terms the code
uses beyond it.

## Purpose

karpathy.app lets one person read, edit and talk to an AI about their **Markdown notes stored in GitHub repos**, from a
phone, iPad or Mac, in the browser. It brings the Obsidian + Claude Code + wiki-skills setup to devices that have no
terminal. The app keeps no content of its own: the notes stay in git, and Obsidian on other devices syncs through the
same GitHub remote. The motivation is in the [README](../../README.md#problem).

## Vocabulary

| Term | Meaning | In code |
|---|---|---|
| **Vault** | A GitHub repo (optionally a subfolder of it) whose Markdown notes the app works on. *Avoid:* workspace, project, notebook. | `VaultConfig` / `Vault` (`packages/shared`) |
| **Vault root** | The folder inside the repo that the vault starts at; the repo root unless a subfolder was configured. Nothing outside it is visible. | `VaultConfig.root` (`''` = repo root) |
| **Vault structure** | The folders a vault is expected to have under its vault root: `Sources/` and `Wiki/` (required) and `Schema/` (optional, only mentioned in the help). Only the required ones are checked, and only when a vault is attached; existing vaults are never checked or repaired. Names match case-insensitively (`wiki/` counts as `Wiki/`). | `REQUIRED_FOLDERS` (`preflight.ts`) |
| **Sources** | `Sources/`: immutable source documents (articles, mails, PDFs, clips) that humans or ingest skills add and that aren't rewritten afterwards. | |
| **Wiki** | `Wiki/`: the knowledge base the AI maintains from the sources (entities, concepts, topics, syntheses, index, log). | |
| **Schema** | `Schema/`: optional instructions for the AI (e.g. `Schema/CLAUDE.md`, methodology). | |
| **Attach preflight** | The check that runs when a vault is added, before anything is stored or cloned into the vault directory: repo and branch reachable with the GitHub token, vault root exists, required folders present. A vault that fails it was never attached. | `preflight()` |
| **Missing folders** | The required folders absent from the vault root of a repo being attached. The user decides whether to create them. | `409 missing-folders` |
| **Folder placeholder** | An empty `.gitkeep` that makes a created folder exist in git. It is an uncommitted change like any other; nothing is committed for the user. | `Vaults.createFolders` |
| **GitHub token** | The single, server-wide credential for every git operation against GitHub (clone, pull, push, preflight). Set in the app's settings or, as fallback, the deployment's `GITHUB_TOKEN` secret. Never sent to the client in full (last 4 characters only), never given to the AI, never written into a repo. | `GitHubToken`, `config.githubToken` |
| **Token source** | Where the active token comes from: `settings` (set in the app, wins), `secret` (the deployment secret, used while none is set in the app) or `none`. | `SettingsView.githubToken.source` |
| **Token test** | A check of a token, the stored one or one typed but not saved: does GitHub accept it, whose is it, its scopes and expiry, and can it reach each configured vault's repo and branch. Stores nothing. | `TokenTest` |
| **Active vault** | The one vault the UI is currently scoped to. | web `store.tsx` |
| **Vault state** | `cloning` → `ready` or `clone-failed`; `ready` ↔ `conflict`. The attach preflight comes before the vault exists, so it is not a state. | `VaultState` |
| **Vault file** | Any file in the vault: a note, a media file or a binary file. The file tree, Delete, the Changes list and commits work on vault files. *Avoid:* note (for anything that isn't text), document, item. | `FileEntry`; web store `note` (identifier kept) |
| **Note** | A vault file that is UTF-8 text, usually `.md`. Only notes can be edited and have a Write/Read mode. | `FileContent.binary === false` |
| **Media file** | A vault file whose extension is in the media table: an image, video or audio file. Shown, never edited. Every media file is binary, not every binary file is a media file. *Avoid:* attachment, asset, resource. | `mediaKind(path)` → `image` · `video` · `audio` · `null` |
| **Media kind** | `image`, `video` or `audio`, from the extension alone (case-insensitive), never from content sniffing. Decides the HTML element and the Content-Type the backend sends. | `MEDIA` (`packages/shared/src/media.ts`) |
| **Binary file** | A vault file that isn't text and isn't a media file (`.pdf`, `.zip`, …). Shown as a file card. | `FileContent.binary && !mediaKind(path)` |
| **Embed** | Markdown that asks for a file to be shown inside a note: `![[target]]`, `![[target\|300]]` (width in px) or `![alt](path)`. Showing it never changes the note. *Avoid:* attachment (that's the file), inline image, transclusion (embedding a note's text, not built). | web `lib/media.ts` `parseEmbed` |
| **File card** | What shows instead of a player: name, size and **Download**, plus **Open** for a PDF (browser's PDF viewer in a new tab), plus **Load anyway (N MB)** for a media file over the preview limit. Also for missing embeds (marked missing, no buttons) and offline. *Avoid:* placeholder. | web `lib/embed.ts` |
| **Preview limit** | 50 MB. A media file up to this size loads by itself; a bigger one loads only on **Load anyway**. | `MAX_PREVIEW_BYTES` |
| **Raw file** | The bytes of a vault file as stored, with a Content-Type from the media table. Read-only, the same path rules as a note. *Avoid:* download (the user action), blob (the browser object). | `GET /vaults/:id/raw?path=` |
| **Version (of a file)** | The first 16 hex characters of the SHA-256 of a file's content. Saves, deletes and discards carry the version they started from. | `files.ts` `versionOf` |
| **Chat** | A resumable conversation with the AI, bound to exactly one vault; its reach is that vault's root. *Avoid:* session, thread, conversation. | one opencode session |
| **Turn** | One user prompt in a chat plus everything the AI reads and changes in response. States `idle`, `queued` (waiting for another turn or for the sync), `running`. | `TurnState` |
| **Consulted file / changed file / opened note** | The three tool-chip kinds of a turn: files the AI read (read tools), wrote (edit/write/patch tools), or asked the app to show (`open_note`). An opened note is neither consulted nor changed: opening reads and writes nothing. | `ToolCall.writes`, `ToolCall.opens` |
| **Open request** | One call of the AI's `open_note` tool. It succeeds only for a file the file tree lists inside the chat's vault root; otherwise it fails as a tool error the AI sees, and nothing opens. | `open_note` tool |
| **Live event vs. history** | Live events arrive on the chat stream while a turn runs; history is the stored chat loaded on reload or when a chat is opened. Only a live open request moves the UI; history shows the chip and moves nothing. | `ChatEvent` vs. `api.chat` |
| **AI-touched** | The set of paths the AI changed since the last commit. A commit that includes one of them gets the `Co-authored-by: karpathy.app agent` trailer. | `config.aiTouched` |
| **Uncommitted change** | A file that differs from its last commit, whether the user or the AI changed it; both are pooled. *Avoid:* draft, pending edit, dirty file. | `Change` |
| **Unsaved change** | An edit held only in the editor (and in a local draft) that hasn't been written to the vault yet. | web `drafts.ts` |
| **Draft** | The local browser copy of an unsaved change (`{base, text}`), kept until the server has the text. Internal term; to the user it's still an unsaved change. | localStorage `karpathy.draft:*` |
| **Commit** | The user-triggered act of recording all uncommitted changes of a vault and pushing them to GitHub in one step. There is no commit without a push attempt. *Avoid:* sync, save, publish. | `Vaults.commit` |
| **Unpushed commit** | A commit whose push failed; it is pushed again on the next pull, commit or manual retry. If GitHub has moved on meanwhile, the next pull turns it back into uncommitted changes. | `VaultStatus.unpushedCount` |
| **Commit reminder** | A prompt that appears once the number of uncommitted changes passes a threshold (default 4), offering to commit. | `Settings.commitReminderThreshold` |
| **Stale save** | A save rejected because the file changed (by the AI or a pull) since the editor loaded it. *Avoid:* conflict (reserved for git). | HTTP 409 `stale` |
| **Conflict** | A git-level clash between the vault's uncommitted changes and changes pulled from GitHub. It blocks all writes to the vault until the user resolves each clashing file: keep **mine**, **theirs** or **both**. | `VaultState` `conflict`, `conflictPaths` |
| **Busy** | What the vault is doing right now: `none`, `turn` (an AI turn holds it) or `sync` (a git operation holds it or waits for it). | `VaultStatus.busy` |
| **Pull** | The backend's sync with GitHub (fetch, fast-forward, re-apply uncommitted changes). Runs on open, before every commit and push, and before every AI turn. There is no user-facing pull button. | `Repo.pull` |
| **Main column / side column** | On the wide layout (≥ 1024 px, chat open): the main column is the flexible one in the middle, the side column the fixed 380 px one on the right. | CSS `#app.wide` |
| **Main pane** | Which of note and chat is in the main column: **note in main** (default) or **chat in main**; the other is in the side column. A per-browser preference, not part of a vault or a chat. *Avoid:* focus (taken by keyboard focus), mode, layout. | web `chatMain`; localStorage `karpathy.chatMain` |
| **Swap button** | The round ⇄ button on the divider between main and side column, at the top; toggles the main pane. Icon only; its label says what a click does ("Move chat to main column" / "Move note to main column"). | `data-testid="main-swap"` |
| **Write mode / Read mode** | Write mode: raw Markdown with live preview, editable; the mode of a new browser. Read mode: the rendered, non-editable view. Media and binary files have no mode. *Avoid:* edit mode, source mode, preview. | web `NotePane` |
| **Mode preference** | The Write/Read mode the user last chose. It applies to every note opened afterwards (tree, search, links, chat chips, AI opens) and survives a reload. One per browser, not per vault or note. *Avoid:* default mode. | web store `mode`; localStorage `karpathy.mode` |
| **Hit position** | Where an opened note should land: a line (search hit) or a heading (`[[note#heading]]`). Write mode puts the cursor on the line; Read mode scrolls to the rendered top-level block that contains the line and briefly highlights it. | store `note.goto`; Read-mode blocks carry `data-line` |
| **Place** | Where the user left a note: scroll position and mode. Back to a note seen in this session restores it; switching Write ↔ Read keeps the same source line. In memory only. | store `places`; web `lib/place.ts` |
| **Web access** | The global setting, on by default. On: the AI may web search and web fetch in every vault. Off: it has neither tool. | `Settings.webAccess` |
| **Web search / web fetch** | One call of `websearch` (a query to the search backend, results with titles, URLs and page text) or `webfetch` (one URL downloaded as Markdown, text or an image). Never just "search" (that's the user's vault search) or "fetch". | `ToolCall.query`, `ToolCall.url` |
| **Known URL** | A URL that appears verbatim in the chat as the model saw it: user messages and earlier tool outputs (notes read, results, fetched pages; a truncated output counts as its preview). Only known URLs may be fetched; scheme/host case, default port and fragment don't matter, path and query must match. | `deploy/opencode/lib/known-url.ts` |
| **Web caps** | At most N web fetches and N web searches per turn, counted separately (default 20 each, per target). | `WEB_FETCH_CAP`, `WEB_SEARCH_CAP` |
| **Web content** | Search results and fetched pages: untrusted input, like an ingested note. Lives only in the chat; reaches the vault only if the AI writes about it. | tool output |
| **Search backend** | Exa, the one recipient of web search queries; fixed by the release (opencode image env). | `OPENCODE_WEBSEARCH_PROVIDER=exa` |
| **Egress proxy** | The only path from the AI's container to the internet; refuses internal addresses. | compose service `egress` |
| **Web chips** | `searched the web: "<query>"` (label) and `fetched <url>` (link to the page); the fourth and fifth chip kinds next to consulted, changed and opened. | web `toolLabel` |
| **Harness config** | An `.opencode/`, `opencode.json` or `opencode.jsonc` inside a vault. Its presence disables chat for that vault, because it could override the AI's restrictions. | `HARNESS_CONFIG` |

### Operations

Terms for running the app, not for using it ([deployment.md](deployment.md)).

| Term | Meaning | In code |
|---|---|---|
| **Release** | A git tag `vX.Y.Z` with the four images CI built from it and the `compose.yml` attached to the GitHub release. Never changes once published; a tag whose images failed to build isn't one. *Avoid:* build, deployment. | `.github/workflows/release.yml` |
| **Pre-release** | A release from a `vX.Y.Z-rc.N` tag, from any commit. Deployable by name, never GitHub's "Latest" or `:latest`. | `guard` job |
| **Version (of a release)** | `X.Y.Z`, the tag without the `v`; also the image tag and what `/api/health` reports. Local builds report `dev`. | `APP_VERSION` |
| **Target** | A named place a release is deployed to: `local` (the Lima VM) or `hetzner`. One host with its own settings and secrets. *Avoid:* environment, stage, server. | `deploy/ansible/inventories/<target>` |
| **Deployment** | One `just deploy <target> [version]`: brings the host to the desired state, starts the release, ends with the smoke check. *Avoid:* rollout, ship. | `site.yml` |
| **Current release** | The release a target runs now; earlier ones stay for rollback. | `/opt/karpathy.app/current` |
| **Rollback** | A deployment of an older release, with today's playbook. | — |
| **Smoke check** | The end of every deployment: containers healthy, `/api/health` through the proxy with the token, the requested version. | `roles/app/tasks/smoke.yml` |
| **Alert** | A push to the operator's phone (ntfy) when something needs a person. | Beszel, Gatus, healthchecks.io |
| **Heartbeat** | A ping to healthchecks.io every 5 minutes; when it stops or reports a failure, healthchecks.io raises the alert. *Avoid:* uptime check. | `karpathy-heartbeat` |
| **Website** | The public product page at `https://karpathy.app`; static, no login, no user data. Not the app, which runs at `app.karpathy.app` (or another target). *Avoid:* homepage, landing page, web app. | `site/` |
| **Website deploy** | Publishing the current `site/` from `main` to GitHub Pages. Independent of releases; the website has no version. *Avoid:* release. | `.github/workflows/pages.yml` |
| **Login link** | `<app url>/#token=…`, shown as a QR code by `just token <target> --qr`; logs a device in. | `lib/login-code.ts` |

## Concepts and entities

```mermaid
erDiagram
  SETTINGS ||--o{ VAULT : "server-wide for all"
  VAULT ||--|| CLONE : "has one local"
  VAULT ||--o{ VAULT_FILE : contains
  VAULT_FILE ||--o| NOTE : "is a (text)"
  VAULT_FILE ||--o| MEDIA_FILE : "is a (image, video, audio)"
  NOTE ||--o{ EMBED : "shows via"
  EMBED }o--o| VAULT_FILE : "resolves to"
  VAULT ||--o{ CHAT : "has, scoped to its root"
  CHAT ||--o{ TURN : "consists of"
  TURN ||--o{ TOOL_CALL : "reads / changes notes via"
  VAULT ||--o{ UNCOMMITTED_CHANGE : pools
  UNCOMMITTED_CHANGE }o--o| NOTE : "is a changed"
  VAULT ||--o{ COMMIT : "user records"
  COMMIT ||--o{ UNCOMMITTED_CHANGE : "records all of"
  VAULT ||--o| CONFLICT : "may be in"
  CONFLICT ||--|{ NOTE : "lists clashing"
  CLONE }o--|| GITHUB_REPO : "tracks branch of"
  GITHUB_TOKEN ||--o{ VAULT : "authenticates git for"
  SECRET ||--o| GITHUB_TOKEN : "fallback"
  VAULT ||--|| VAULT_ROOT : has
  VAULT_ROOT ||--|| SOURCES : "requires"
  VAULT_ROOT ||--|| WIKI : "requires"
  VAULT_ROOT ||--o| SCHEMA : "may have"
```

- **Settings** are server-wide: the commit reminder threshold and the **model** (`provider/model`, default
  `anthropic/claude-sonnet-5`). There is no per-chat model. The **GitHub token** is managed next to them but is
  stored separately from them (never part of `Settings`).
- The **GitHub token** is optional in the app: with none set, the deployment's `GITHUB_TOKEN` secret is used.
  Removing the stored token falls back to the secret again. A token changed in the app applies to the next git
  operation without a restart. There is one token for all vaults; one per owner would be the follow-up if vaults ever
  span several owners (a fine-grained token covers one owner's repos).
- A **vault** is identified by a slug `id`, and configured by `name`, `repo` (`owner/name`), `branch` and `root`.
  The same repo + branch + root can't be added twice, also not while the first add's preflight is still running.
  A vault exists in the config only after its attach preflight passed and, if folders were missing, the user agreed
  to create them.
- A **vault file** is identified by its path relative to the vault root; dot-files and `.git` are never listed.

### Media kinds

Modeled on Obsidian's accepted formats, limited to what browsers can play:

| Kind | Extensions | Shown as |
|---|---|---|
| Image | `png` `jpg` `jpeg` `gif` `webp` `avif` `bmp` `svg` | `<img>` (SVG sanitized, only ever inside `<img>`) |
| Video | `mp4` `webm` `mov` `m4v` `ogv` | `<video controls playsinline>` |
| Audio | `mp3` `m4a` `wav` `ogg` `flac` `opus` | `<audio controls>` |
| PDF | `pdf` | File card with **Open** (new tab) and **Download** |
| Anything else non-text | | File card with **Download** |

## Actors

| Actor | What it can do |
|---|---|
| **Operator** (the same person as the user, on the Mac) | Cuts releases, deploys them to the targets, holds the vault passwords (Keychain) and gets the alerts. |
| **User** (single person, holds the bearer token) | Manage vaults and settings, read and edit notes, search, chat with the AI, review diffs, discard, commit and push, resolve conflicts. Uses the app as a PWA on phone, iPad and desktop. |
| **AI** (opencode agent, on the user's behalf) | Inside one vault root only: read notes; write notes unless the vault is in conflict (then read-only); open one note in the user's editor when the user asks to see it (also in conflict). With Web access on: web search, and web fetch of known URLs (also in conflict). It can't run shell commands, fetch URLs it built itself, reach internal hosts, read `.env` files, edit `.git` or harness config, commit or push. |
| **Search backend (Exa)** | Receives the AI's web search queries; returns results. |
| **Public web** | Serves fetched pages; untrusted. |
| **Obsidian / other git clients** | Change the same GitHub repo from other devices; their changes arrive on the next pull and can cause a conflict. |
| **GitHub** | Hosts the vault repos; the backend clones, fetches and pushes with the GitHub token, and asks `GET /user` to test it. |
| **LLM provider** (e.g. Anthropic; Ollama in dev) | Runs the model behind opencode. Sees the prompts and the note content the AI reads. |

## Processes

### Attach a vault

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web app
  participant B as Backend
  participant G as GitHub
  U->>W: Add vault (repo, branch, root)
  W->>B: POST /vaults
  B->>G: shallow, blobless fetch of the branch (token)
  alt repo or branch unreachable / root missing
    B-->>W: 422 repo-unreachable / root-missing
    W-->>U: inline error, nothing attached
  else Sources/ or Wiki/ missing
    B-->>W: 409 missing-folders [Sources, Wiki]
    W->>U: "Create folders?"
    alt Don't attach
      W-->>U: form stays filled, nothing attached
    else Create folders
      W->>B: POST /vaults createFolders=true
      B-->>W: 202 (vault stored, cloning)
      B->>B: clone, then write .gitkeep in each missing folder
    end
  else all present
    B-->>W: 202 (vault stored, cloning)
  end
```

The created folders are uncommitted changes until the user commits (ADR 0001). A failure after the preflight (network
drop, disk full) is a normal `clone-failed` vault with Retry and Edit.

### Edit a note

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web app
  participant B as Backend
  U->>W: types in Write mode
  W->>W: mirror to local draft
  W->>B: PUT file {content, version} (1.5 s after last keystroke)
  alt version matches
    B-->>W: new version
    W->>W: drop draft, "Saved"
  else file changed meanwhile (stale save)
    B-->>W: 409 stale
    W->>U: "Note changed elsewhere": reload or overwrite
  else vault in conflict
    B-->>W: 423
  end
```

### Resolve an embed

The same rules Obsidian uses. The wikilink form resolves like a `[[link]]` (the target keeps its extension); the
Markdown form is a path relative to the note.

```mermaid
flowchart TD
    E{Embed form?}
    E -->|wikilink form| W[target = text before the bar<br/>width = number after the bar]
    W --> R1[resolveWikilink: exact path,<br/>path suffix, then basename:<br/>note's folder first, then<br/>shortest path, then A–Z]
    E -->|Markdown form| P{http:, https:,<br/>data: or //?}
    P -->|yes| L[Left as a link:<br/>remote images stay blocked]
    P -->|no| R2[URL-decode, resolve against<br/>the note's folder, normalize ..]
    R2 --> IN{inside the vault<br/>and in the file list?}
    R1 --> K
    IN -->|yes| K{media kind?}
    IN -->|no| MISS[File card: missing]
    R1 -->|no match| MISS
    K -->|image / video / audio| PLAY[Player]
    K -->|none: a note| NOTE["Shown as a [[link]]<br/>(no transclusion)"]
    K -->|none: pdf, other| CARD[File card]
```

In chat there is no note path: relative paths resolve from the vault root.

### Show a media file

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web app
    participant C as Object-URL cache
    participant B as Backend
    U->>W: opens a note with ![[clip.mp4]]
    W->>W: render: embed → placeholder with data-path
    W->>C: objectUrl(vault, clip.mp4)
    alt cached
      C-->>W: blob: URL
    else not cached
      C->>B: HEAD /raw?path=clip.mp4 (Bearer)
      alt Content-Length > 50 MB
        C-->>W: too large → file card with Load anyway
      else
        C->>B: GET /raw?path=clip.mp4
        B-->>C: bytes (Content-Type video/mp4)
        C-->>W: blob: URL
      end
    end
    W->>U: <video src=blob:… controls playsinline>
```

### The mode preference

```mermaid
stateDiagram-v2
    [*] --> Write: new browser
    Write --> Read: user taps Read
    Read --> Write: user taps Write
    Write --> Write: open any note, reload
    Read --> Read: open any note, reload
    note right of Read
      Opening a media or binary file
      shows the file and leaves the
      preference unchanged.
    end note
```

No navigation changes the mode; only the Write/Read toggle does.

### AI turn

1. The user sends a prompt; the backend queues the turn (one running turn per vault; the queue survives restarts).
2. Before the turn starts the backend **pulls** under an exclusive lock, then downgrades to a shared lock without
   letting any other git operation in between.
3. opencode runs the turn with the `vault` agent (or `vault-readonly` while in conflict). Reads and writes stream to
   the UI as tool chips; written paths join the AI-touched set. An **open request** (`open_note`) that completes
   opens the note in the editor: on the wide layout right away, on a phone or in the tablet overlay when the turn
   ends (only the last one of the turn); while the user is editing, a notice and the "opened" chip show it instead.
4. With **Web access** on, the turn may also web search and web fetch known URLs through the egress proxy; each
   call streams as a web chip. A fetch of an unknown URL fails as a tool error and the turn goes on.
5. The lock is released when opencode reports the session idle. Changes stay uncommitted.

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web app
  participant B as Backend
  participant O as opencode
  U->>W: "show me my reading list"
  W->>B: POST prompt
  B->>O: prompt (agent vault / vault-readonly)
  O->>O: read / glob to find the note
  O->>O: open_note("Lists/Reading.md") → file exists → "opened"
  O-->>B: tool part completed
  B-->>W: part {tool call, opens: true, path}
  W->>W: wide: openNote(path) now
  Note over W: phone / tablet overlay: waits until the turn ends, then opens
```

### Commit

1. The user opens the commit dialog; the app flushes the open note and asks for a proposed message (a tool-less AI
   agent, 15 s timeout, fallback "Update N files").
2. The backend takes the exclusive lock, **pulls**, checks that the set of changed paths is still the one the user
   reviewed (else 409 `changes-moved`), commits everything in the vault root (with the AI trailer if needed) and pushes.
3. A failed push leaves an **unpushed commit**, retried on the next pull or by the user.

### Pull and conflict

```mermaid
flowchart TD
  F[fetch origin/branch] -->|fails| OFF[offline: keep working, show pullError]
  F --> M{upstream moved?}
  M -->|no| P[push unpushed commits] --> OK[ok]
  M -->|yes| U{unpushed commits?}
  U -->|yes| R[reset --mixed to merge-base:<br/>they become uncommitted changes]
  U -->|no| S
  R --> S{uncommitted changes?}
  S -->|yes| ST[stash incl. untracked] --> FF
  S -->|no| FF[fast-forward to origin]
  FF --> POP{stash pop clean?}
  POP -->|yes| OK
  POP -->|no| C[CONFLICT: writes blocked,<br/>user's version shown, stash kept]
  C --> RES[user resolves each file:<br/>mine / theirs / both]
  RES -->|last file| OK
```

"Both" keeps the user's version at the path and writes GitHub's next to it as `<name>.conflict-YYYY-MM-DD.md`.

## Rules and constraints

- **The AI never commits or pushes** ([ADR 0001](../../docs/adr/0001-user-triggered-commits.md)); only the user's
  commit does, and it records **all** uncommitted changes of the vault root (no partial staging).
- **Everything is scoped to the vault root:** file access, search, git status/diff/add, and the AI's session
  directory. Changes outside the root are invisible.
- **Conflict blocks writes:** saves, deletes, discards and commits are refused (423); AI turns run read-only; repo,
  branch or root changes and vault removal are refused.
- **Optimistic concurrency everywhere:** saves, deletes and discards carry the file version they started from; a
  commit carries the paths the user reviewed.
- **No data loss on pull:** unpushed commits are folded back into uncommitted changes; during a conflict the stash is
  kept until every file is resolved.
- **A vault is attached only after a passing preflight.** Unreachable repo or branch and a missing vault root are
  refused and nothing is stored. Missing `Sources/` / `Wiki/` are created only with the user's consent, as uncommitted
  placeholders. Changing repo, branch or root of an existing vault (PATCH) has no preflight.
- **Removing a vault deletes only the local clone** (never the GitHub repo) and requires no uncommitted changes and no
  unpushed commits. Changing repo, branch or root has the same precondition.
- **New file names** may not contain `<>:"|?*\` or control characters, may not be Windows-reserved names, end in a dot
  or space, differ from an existing file only by case, or be harness config.
- **Chat is disabled** in vaults that contain harness config.
- **The AI opens a note only when the user asks to see it**, never on its own after writing. Any file the file tree
  lists can be opened (media files in the media view, other binaries as a file card); dot-paths and `.git` can't. Opening is not a change: it never
  joins the AI-touched set and works during a conflict.
- **One live open moves the UI once:** a replayed or reloaded call doesn't open again; a call that completed while the
  stream was down still opens when the chat reloads. While the user is editing (editor focused or unsaved text), the
  AI never switches the note; a blocked switch (stale save, deleted note) is not retried.
- **The main pane is a per-browser preference:** swapping only moves the two columns (CSS), so a running turn, typed
  text, focus, scroll and undo history survive; closing the chat or leaving the wide layout keeps the preference.
- **An embed never changes the note text.** Write mode shows the embed as a block below its line and keeps the raw
  `![[…]]` text editable. Note transclusion (`![[Other note]]`) renders as a link.
- **Media kind comes from the extension only.** The backend sends the media table's Content-Type with `nosniff`; any
  other file goes out as `application/octet-stream` (PDF as `application/pdf`) with `Content-Disposition: attachment`,
  so the browser never renders it.
- **SVG is only ever shown inside `<img>`** and is sanitized before it becomes a blob URL; its file card downloads it
  and never opens it as a page. **Open** exists only for `.pdf`, as a blob the app typed `application/pdf`.
- **Remote images stay blocked:** `![](https://…)` renders as a link (no tracking pixels from git-sourced notes).
- **Duplicate names:** a basename match prefers the note's own folder, then the shortest path, then A–Z. Embeds and
  `[[links]]` resolve the same way.
- **The width after the bar** (`|300`, `|300x200`, height ignored) applies to images, videos and audio alike; other
  text after the bar is the caption (`alt`).
- **Tapping an embedded image** (Read or Write mode) opens that media file in the note pane; video and audio keep
  their controls.
- **Place:** Back to a note seen in this session returns to where the user left it; switching Write ↔ Read keeps the
  same source line (per top-level block). A new open lands at the top or its hit position.
- **Media is read-only** for the user and the AI; there is no upload or paste. Offline, media isn't available.
- **Web access off means invisible:** the model sees neither web tool. The commit-message agent never has them.
- **Only known URLs are fetched;** web content never counts as instructions from the user (a rule for us, not a
  promise about the model; the commit review stays the safety net).
- **Single user:** one bearer token, one git identity, one server-wide model.
