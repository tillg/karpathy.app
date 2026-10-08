<p align="center"><img src="assets/icons/icon-192.png" alt="karpathy.app logo" width="128"></p>

# karpathy.app

**Website: [karpathy.app](https://karpathy.app)**

A mobile-friendly web app that combines an Obsidian-style Markdown vault with an
AI dialog — so that the knowledge (the `.md` files) and the AI assistant that reads,
writes, and ingests into it can be used **on iPad and phone**, not just in the
terminal on the Mac.

## Problem

The existing setup is: Obsidian vault + Claude Code (CLI) + skills, all local on
the Mac. On mobile, only reading/editing the `.md` files works (Obsidian app). The
**AI + skills** are tied to the terminal and the Mac.

## Solution

A web app (PWA) that unites two things in one place:

1. **Obsidian core:** list, read, edit, search `.md` files (wikilinks,
   frontmatter).
2. **AI dialog:** chat UI in the app; an external LLM (any provider — Claude,
   OpenAI, OpenRouter, local via Ollama, …) is called; the **agentic loop runs in the
   backend on an existing harness** ([opencode](https://github.com/anomalyco/opencode))
   and gets tools to search and edit exactly these `.md` files.

Core idea: **don't** build the agentic loop, tool calling, and skills yourself —
opencode runs headless as a server and brings a provider-agnostic loop, file tools,
skills, `AGENTS.md`/`CLAUDE.md`, and MCP. Only the frontend (editor + chat) and a thin
backend (file API + opencode client + git sync) get built.

## Sync

Every vault is a **GitHub repo**. In the app's **Vaults** dialog (vault menu → **Manage vaults…**) you configure which repos
are your vaults; the backend clones them. Your and the AI's edits stay uncommitted until
you hit **Commit & Push**. Obsidian mobile and desktop are attached to the same remotes. No second sync system.

**Vault structure.** A vault root has a `Sources/` folder (immutable source documents) and a
`Wiki/` folder (the knowledge base the AI maintains); `Schema/` (instructions for the AI) is optional.
Lowercase `sources/` and `wiki/` count too. When you add a repo, the app checks it before attaching
anything: is it reachable with the token, do the branch and root exist, and are `Sources/` and `Wiki/`
there? If folders are missing, it offers to create them (as uncommitted `.gitkeep` files). If you
decline, the vault is not attached. The `(?)` in the **Vaults** dialog explains this in the app.

**GitHub token.** One token is used for every vault. Set or replace it in **Settings** (the gear in the sidebar), and
check it with **Test token**, which shows whose token it is, its expiry, and whether each vault's repo
is reachable. The app shows only its last 4 characters. Without a token set in the app, the
backend uses the `github_token` secret of the deployment.

**Web access.** The AI can search the web and read pages. It is on by default; switch it off under
Settings (the gear) → Web access (one switch for all vaults). Each search and page read shows as a
chip in the chat (`searched the web: "…"`, `fetched example.com/post`); a fetched chip opens the page.
Searches go to Exa. `EXA_API_KEY` in `deploy/opencode.env` is optional (see `deploy/opencode.env.example`);
without it Exa's anonymous endpoint is used, which is rate-limited, so set a key in production
(`just secrets <target>` asks for it). The AI can fetch only URLs that already appear in the chat (you
paste them, or a note or search result contains them), at most 20 fetches and 20 searches per turn
(`WEB_FETCH_CAP` / `WEB_SEARCH_CAP` in `opencode.env`, applied on restart). The opencode container
has no direct internet access: it goes through an `egress` proxy that refuses private, loopback and
link-local addresses, and opencode's API needs a generated password. Note that `localhost`/`127.0.0.1`/`0.0.0.0` are in opencode's `NO_PROXY`, so loopback requests (needed by its plugin client) bypass the proxy: only that password protects opencode's own API from the AI's web fetches (`opencode_password` secret; dev
and prodtest create it, deploys generate it once on the target). Ask the AI to open a web page ("open the
Wikipedia page on X") and it offers it as an **Open chip** (`open en.wikipedia.org/…`); the page opens in a
new browser tab only when you tap the chip. It works with Web access off (your browser loads the page, not
the server), and only for URLs that already appear in the chat, like fetches.

Ask it to add a picture, video, audio file or PDF from a URL to a note ("add a picture of X from <URL> to this note") and it saves the file as a new vault file next to the note and embeds it (`save_url`; Web access on, not in conflict, known URLs only, counts as a fetch, never overwrites, max 50 MB).

**Commands.** Typing `/` in the chat composer opens the **command palette**: the vault's skills with their
descriptions, filtered as you type; picking one fills in `/name ` for the arguments (slash commands). A new,
empty chat shows up to four **command chips** (the ones you used last in this vault first); a tap puts `/name `
in front of what you typed and sends nothing. Sending `/query what is X` runs the `query` skill: the chat
shows what you typed, and the skill's text goes to the AI as a hidden part of the same message (never through
opencode's command endpoint, which would run shell snippets from the skill file). A `/word` that is no command
of the vault is sent as plain text. The palette shows two kinds: **vault skills** ("This vault", tag `vault`),
which live in the vault's `.agents/skills/`, sync through git and also work in Claude Code on the Mac; and
**app skills** ("karpathy.app", tag `app`), which ship with the app and exist in every vault. If a vault skill
has the same name as an app skill, the vault skill wins and the palette says it replaces karpathy.app's.

**`/research <topic>`** is the app skill for deep research. The first turn reads the wiki, scouts the web a
little (at most 3 searches and 2 fetches) and writes a **plan note** `Research/<date>-<slug>.md` with 3–6
sub-questions, then stops. Edit the note if you like and reply **go**: the run turn searches the web, saves
useful pages as source files in `Sources/` (with `url`, `title`, `fetched` and a summary, never the full page),
writes or updates wiki pages that cite them, and ticks off the plan note (at most 8 sources per turn; reply
**continue** for more). `/research Research/<date>-<slug>.md` resumes a plan in any chat. Everything stays
uncommitted until you review and commit.

**Vault layout: the `.agents` standard.** Vaults follow the open `.agents` standard that opencode, Codex,
Cursor, Gemini CLI and others share: instructions in `AGENTS.md`, skills in `.agents/skills/<name>/SKILL.md`,
rather than Anthropic's `CLAUDE.md` / `.claude/`. opencode runs with `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`,
so `.claude/skills/` is ignored (a vault's `CLAUDE.md` is still read until the vault is moved). The app moves
a vault to the standard by itself after every clone, pull and open (never while it is in conflict):
`CLAUDE.md` becomes `AGENTS.md` with its `@path` imports pasted in (opencode doesn't expand them),
`.claude/skills/*` move to `.agents/skills/`, and `.claude/commands/*.md` become skills. It leaves
`CLAUDE.md` = `@AGENTS.md` and a symlink `.claude/skills → ../.agents/skills`, so Claude Code on the Mac keeps
working. It never overwrites an existing name (the clash is listed), shows a notice with **Review**, and leaves
ordinary uncommitted changes (discarding them undoes the move until the next pull). Skills that come from a
Claude Code plugin aren't in the vault and don't show; copy them into the vault.

## Status

MVP (spec milestone M4) implemented: vaults from GitHub, file tree, CodeMirror editor with
live preview and `[[wikilinks]]`, search (several words find notes with all of them, `"quotes"` for a phrase), a 3D graph of the notes and their links (graph button in the sidebar; tap a note to open it), uncommitted changes / diff / discard, Commit & Push
with an AI-proposed message, conflict resolution, and a streaming AI chat that reads and
edits the vault through opencode. Ask the AI to show you a note ("open my reading list") and it
opens notes in the editor through its `open_note` tool (on a phone or a smaller iPad when the reply is
done; never while you are typing). On a wide screen the ⇄ button on the note/chat divider swaps the two
columns, putting the chat in the large main column; the browser remembers the choice. Images, video, audio
and PDFs in a note show up as **embeds** (`![[photo.png]]`, `![[clip.mp4|300]]`, `![alt](img/a.png)`) in Read mode, in
Write mode (a block below the line; the text stays as written) and in chat answers; tapping an image opens
it, Back returns to the same place, and media over 50 MB loads only on a tap. **Attach photos and PDFs**: the
**+** in Write mode (Take photo / Choose file) or **drag and drop** from Finder uploads JPEG, PNG, GIF, WebP or PDF
into the page's **own folder** (`Wiki/foo/foo.md`; a flat `Wiki/foo.md` is moved there first and path-form links
to it are rewritten) and embeds it as `![[name]]`. Photos are scaled to 2048 px and lose their GPS metadata;
50 MB cap, a warning above 10 MB. The **+** in the chat composer uploads up to 5 files into a new
`Sources/upload-…/` folder and sends them to the AI with the prompt (a model without image/PDF input only gets
the path; the chip says so). Uploads are uncommitted changes like any edit. The **Write/Read mode is sticky**:
it stays as you chose it for every note you open and survives a reload (Write is the default). **Sort and
filter the file tree**: the ⇅ button in the Notes header sorts by name or by last change (either direction;
folders rise with recent changes inside them), the funnel shows only notes changed by the AI or by a human
(a chip with ✕ says a filter is on). The AI/human dates come from the app's own records and from git history
(a commit without the app's AI trailer counts as human); the browser remembers both choices. **Incoming
changes**: while the app is open, the backend fetches the vault from GitHub every 2 minutes and whenever you
switch back to the app; files pushed from elsewhere (e.g. Obsidian) show as "· N incoming" next to the git
status pill (on a phone, a "↓" on the Changes tab), are listed in Changes, and the open note says "Changed on
GitHub · Pull" when it is one of them. One tap pulls them in (the same pull as before a commit; nothing is
pulled automatically). How it works today: [`specs/system/`](specs/system/) (domain,
functional, architecture, security, deployment); key decisions: [`docs/adr/`](docs/adr/). The
original MVP spec, plan, opencode spike and implementation log are in git history
([`specs/01_mvp/` at 9c25f72](https://github.com/tillg/karpathy.app/tree/9c25f7242ad08a53ac6d57ec57180036a4c9a14e/specs/01_mvp)).
Feature ideas from similar projects (30, ranked, filed as issues #64–#93):
[`specs/research/features/feature-report.md`](specs/research/features/feature-report.md) (interactive version:
`feature-report.html`, rebuilt with `node specs/research/features/build-report-html.mjs`).
Browser-only (serverless) architecture research with spikes:
[`specs/research/browser-only/browser-only-report.html`](specs/research/browser-only/browser-only-report.html).
V1 plan draft (an open change): [`specs/changes/v1/v1-plan.html`](specs/changes/v1/v1-plan.html).
Production environment research (hosters and free tiers, Hetzner vs IONOS, security, disk space):
[`specs/research/prod-env/prod-env-report.html`](specs/research/prod-env/prod-env-report.html).
Generating the reports from Markdown (done, now the md2html plugin):
[`specs/06_md_to_html/` at 5347702](https://github.com/tillg/karpathy.app/tree/53477023d48752e5bc4c37b68a552dddfdac5ea8/specs/06_md_to_html).
These HTML reports are generated from the `.md` next to each (see [Reports](#reports)).
UI layout prototypes from the MVP design (layout 07 was built) —
**[view rendered](https://raw.githack.com/tillg/karpathy.app/9c25f7242ad08a53ac6d57ec57180036a4c9a14e/specs/01_mvp/layouts/index.html)**.

## Running it

Everything runs in docker compose (on this Mac: Rancher Desktop), except the dev model: one native
Ollama on the Mac (Metal GPU), shared by all dev stacks. Set it up once with `brew install ollama` and
`just ollama install` (a LaunchAgent on 127.0.0.1:11434; `just ollama status|uninstall`).

**Dev** (hot reload, `qwen2.5:3b` on the native Ollama as the model). Several dev stacks run side by side,
one per checkout (main clone or worktree): stack N (1–9) is on https://localhost:80N0, and its header
reads `karpathy #N`.

```sh
just dev                # stack of this checkout, else the first free one: builds, starts, pulls the model once, prints URL + token
just dev up 2           # pick stack 2 (refused if another checkout owns it)
just dev stacks         # which stacks are free, and which checkout owns the others
just dev logs           # also: ps, token
just dev down
```

Stack N owns the ports 80N0–80N9: 80N0 the app, 80N1 the backend (http, loopback), 80N5 the
paired prodtest. Each stack's `ollama` service is only a relay to the native Ollama. The number is remembered in `tmp/dev/stack`; `just e2e` and
`just prodtest` use it.

`just` lists all commands (`brew install just`); they wrap `deploy/dev.sh` and npm. Deploying
also needs `brew install lima ansible ansible-lint qrencode jq` (the local target VM, the playbook,
the login QR code and the deploy scripts).

Notes open at `https://localhost:80N0/#/<vault>/<path>` (Back/Forward work). Binary files
(images, PDFs, …) are listed but not editable. A vault whose clone failed can be retried
from the **Vaults** dialog. Unsaved edits
are also kept on the device and restored after a reload or a lost connection. For the
offline cache / PWA install in your own browser, trust Caddy's dev CA (in the proxy
container under `/data/caddy/pki/authorities/local/root.crt`). The app reloads itself when
a new version is out (checked on load and whenever it comes back into view). If a browser
still shows an old build, delete the site's website data (Safari: Settings → Privacy →
Manage Website Data → `localhost`) and enter the token again.

To clone from GitHub in dev, put a token into `deploy/secrets/github_token` (or set one under
Settings in the app). To work
offline against local bare repos instead, create them under `tmp/dev/remotes/<owner>/<name>.git`
and set `GIT_REMOTE_BASE=file:///remotes/` in `deploy/.env`.

**Prod** (the Hetzner server `app.karpathy.app`, reachable only over Tailscale) is never built or
configured by hand: releases go there with `just deploy hetzner`, see [Deploying](#deploying).

## Tests

```sh
npm test               # unit + integration: real git against local bare repos, real opencode container (Docker)
npm run test:github    # @github: clone/push against the throwaway repo tillg/karpathy-app-test-vault
npm run test:llm       # @llm: real model turns (default: local Ollama qwen2.5:3b, see apps/backend/test/opencode-container.ts)
                       # the /research tests need a capable model: LLM_TEST_MODEL=openrouter/z-ai/glm-5.3 with OPENROUTER_API_KEY set (costs money)
npm run test:e2e       # Playwright against this checkout's dev stack
npm run typecheck
```

`just check` runs lint, typecheck, `npm test` and the stack tooling's tests (`deploy/stack.test.sh`,
`e2e/stack.unit.ts`; they need Docker, and test against the native Ollama when it runs).

To run the e2e suite against the **prod images** (https://localhost:80N5, paired with this
checkout's dev stack N): `just prodtest`, `just prodtest e2e [playwright args]`, `just prodtest down`; details in the header of `deploy/compose.prodtest.yml`: `E2E_BASE_URL`, `E2E_TOKEN_FILE` and `E2E_BACKEND_CONTAINER`
point Playwright at it.

Tests that need a real model turn are tagged `@llm` in their title; `--grep-invert @llm` skips them.

Accessibility: `e2e/a11y.spec.ts` runs axe-core (WCAG 2.1 AA + best practice) over the main
screens in light and dark mode and fails on serious/critical findings; `e2e/a11y-keyboard.spec.ts`
covers dialog focus trapping, menu/radio-group keys and phone touch-target sizes.

Layout: `apps/backend` (Express 5, Node/TS), `apps/web` (Vite + React PWA),
`packages/shared` (API types, media table), `deploy/` (compose, Dockerfiles, Caddy, opencode config),
`e2e/` (Playwright).

## Deploying

A release is a git tag; CI builds its images and Ansible puts it on a server from the Mac, with
monitoring and a smoke check. **How it works, every `just` recipe, secrets and the first-server
procedure: [`deploy/README.md`](deploy/README.md).** The short version:

```sh
just release 0.3.0            # tag v0.3.0 → images on GHCR + GitHub release
just deploy hetzner 0.3.0     # put it on the server (`local`: the test VM on https://localhost:9444)
just token hetzner --qr       # log a phone or iPad in by scanning a QR code
```

## Development

Project skills live in `.claude/skills/`, vendored from
[mattpocock/skills](https://github.com/mattpocock/skills) (`c55ee46`, without the
`agents/` Codex configs). Upstream `code-review` is dropped here: its two-axis review
(standards + spec) is merged into the spec plugin's `/spec:adversarial-code-review`, which
`implement` and `tdd` are adjusted to call:

| Skill | Use |
|---|---|
| `/grill-with-docs` | Interview about a plan; records terms in `CONTEXT.md`, hard decisions as ADRs in `docs/adr/` |
| `/to-spec`, `/to-tickets` | Turn a conversation or plan into a spec / tracer-bullet tickets on the issue tracker |
| `/wayfinder` | Chart a large effort as a map of decision tickets and resolve them one by one |
| `/triage` | Move issues through triage states and write agent briefs |
| `/implement` | Implement a spec/tickets test-first, then review |
| `tdd`, `codebase-design` | Red-green loop, deep-module vocabulary |
| `/setup-matt-pocock-skills` | One-time repo setup (issue tracker, triage labels, domain docs) that `to-spec`, `to-tickets`, `triage` and `wayfinder` expect |

Supporting skills called by the ones above: `grilling`, `domain-modeling`, `research`,
`prototype`.

### Plugins

`.claude/settings.json` registers the
[till-claude-code-marketplace](https://github.com/tillg/till-claude-code-marketplace) and Matt
Pocock's [`mattpocock/skills`](https://github.com/mattpocock/skills) marketplace (both with
auto-update), and enables `spec` (spec workflow: `/spec:explore`, `/spec:propose`, `/spec:grill`,
`/spec:apply`, …), `md2html`, `mattpocock-skills` (needed by `/spec:grill`) and `claude-security`
from the official marketplace. The spec skills come only from there: the `.claude/skills/` above are
a different, vendored set.

After cloning: start `claude` in the repo and **trust the folder**. In that first session a
`SessionStart` hook installs any of the four plugins that are missing (`claude plugin install …
--scope project`); they load from the **next** session on (restart, or `/reload-plugins`). When
adding or removing a plugin, keep the hook's list in sync with `enabledPlugins`.

### Reports

Reports under `specs/` are Markdown (`*-report.md`, `v1-plan.md`) rendered to self-contained HTML
by the [md2html](https://github.com/tillg/till-claude-code-marketplace/tree/main/plugins/md2html)
plugin, used only through its skills (no local copy of the tool):

| Skill | Use |
|---|---|
| `/md2html:write` | Write or edit a report (the `.md`); the plugin's hook lints every edit |
| `/md2html:build` | Build the HTML; `--check` fails on lint errors, non-canonical Markdown or stale HTML |

Config: `reports.json` (which files, menu bar, brand, theme); theme: `specs/reports-theme.css`.
Improvements go into the plugin in the marketplace repo, not into local scripts.

## Website

The product page at [https://karpathy.app](https://karpathy.app) is plain HTML + CSS in [`site/`](site/),
styled with the app's design tokens (copied from `apps/web/src/styles.css`; `npm test` fails if they
drift) and the icons from `assets/icons/`. Preview it with `just site` (http://localhost:8099). Every push
to `main` that touches the site deploys it to GitHub Pages ([`pages.yml`](.github/workflows/pages.yml)).

## Name

`karpathy.app` — renamed from the working title `karpathy.ai` (#95). Domain: `karpathy.app` (#94).

## Logo & icons

Master logo: [`assets/karpathy_app_logo.png`](assets/karpathy_app_logo.png). Favicon
(`favicon.ico` 16/32/48 + PNGs), Apple touch icon (180), PWA icons (192/512) and a
maskable 512 icon live in `assets/icons/`; regenerate them with `assets/make-icons.sh`
(needs ImageMagick 7).
