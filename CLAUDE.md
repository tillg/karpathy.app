# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Document everything in English (code, comments, docs, specs, commit messages). Vault *content*
(the user's `.md` notes the app reads/edits) may be in German, French, or any other language —
don't translate or normalize it.

## Reports and docs

- Reports and docs (research, analyses, plans for the user to read) are **HTML** by default. Use
  **Markdown** instead when the user is likely to edit the document a lot. If unsure which, ask.
- **HTML reports are generated from Markdown with md2html** (plugin `md2html@till-claude-code-marketplace`,
  enabled in `.claude/settings.json`). Write and edit the `.md` with `/md2html:write`; never edit the
  generated `.html` next to it. Build and check only through the plugin (`/md2html:build`, `--check`);
  there is no local copy of the tool and no `just` recipe. Missing functionality goes into the plugin in
  the marketplace repo, not into local scripts. A new report must be added to `sources` and `reports`
  (menu bar) in `reports.json`.
- The look is md2html's `base.css` (the Apple-like house style: light + dark, phone width) plus the small
  project theme `specs/reports-theme.css`. The layout (menu bar, title + icon, Created / Last edited /
  Status, subtitle, TL;DR, TOC, numbered sections, figures with `.mmd` source links) is derived from the
  frontmatter and plain Markdown; the cheat sheet ships with `/md2html:write`.
- Content rules the tool can't enforce: TL;DR first (answer, then the few reasons, then the
  recommendation), sources / appendix last, bump `edited` on every content edit, diagrams as pre-rendered
  SVGs next to their `.mmd` (Mermaid is not rendered by the build).
- Exception: `specs/research/features/feature-report.html` is interactive and still built by
  `node specs/research/features/build-report-html.mjs` from `feature-report.md`; its menu bar comes from
  `specs/reports-nav.js`, so keep that list in sync with `reports.json`.

## Status

MVP (milestone M4) implemented and deployed. The source of truth for how the system works is
[`specs/system/`](specs/system/) plus the ADRs in `docs/adr/`; read the relevant pages before changing
anything. Commands: `just` (see `README.md`).

`specs/` layout: `system/` (how the system is), `changes/<name>/` (open spec changes, spec plugin;
archived = folded into `system/` and deleted), `research/<name>/` (research results, kept as reference).

## What this is

Mobile-friendly PWA that combines Obsidian-style Markdown vaults with an AI chat that can
read/write/ingest into them — so the existing Obsidian + Claude Code + wiki-skills setup
works from iPad/phone, not just the Mac terminal.

## Architecture (planned)

- **Frontend:** Vite + TypeScript + React PWA. Vault switcher, admin area
  (configure vaults), panels: file tree, editor, vault search, streaming chat (shows which files the AI reads/changes).
- **Editor: CodeMirror 6** editing raw Markdown (live preview via decorations). Deliberately
  *not* Milkdown/ProseMirror: WYSIWYG re-serialization causes diff noise and conflicts with the
  AI's raw edits. Preserve lossless round-trips of frontmatter and `[[wikilinks]]`.
- **Backend:** Node/TS, thin. Vault admin API (`GET/POST /vaults`, `PATCH/DELETE /vaults/:id`),
  per-vault file API (`GET /vaults/:id/files`, `GET/PUT /vaults/:id/file?path=`,
  `GET /vaults/:id/search?q=` via ripgrep) + per-vault git API, event stream (`GET /vaults/:id/events`) and chat API
  (`/vaults/:id/chats/...`), streamed as NDJSON over `fetch`. Full route list: `apps/backend/src/app.ts`.
- **Agentic loop = opencode** (`opencode serve` container, one session per vault directory, driven via
  `@opencode-ai/sdk`). Provider-agnostic by design — never hard-wire a specific LLM provider.
  Do **not** reimplement the loop, tools, or skills — opencode's built-in file tools, skills
  (`SKILL.md`, incl. `.claude/skills`), `AGENTS.md`/`CLAUDE.md`, and MCP are the point. Keep the
  backend↔harness boundary small and ACP-shaped so the harness stays swappable.
- **Data model: vault = GitHub repo.** The app manages several vaults, configured in an in-app
  admin area (repo, branch, optional root) and stored in a backend-only config volume. The
  backend clones each one to `/vaults/<id>`. Every file, search or chat operation is scoped to
  one vault (`/vaults/:id/...`).
- **Sync = git.** Each vault is a clone on the backend host. Human and AI edits stay
  uncommitted until the user commits (= commit + push); the AI never commits (ADR 0001). Obsidian mobile/desktop share the
  same remote. No second sync system.
- **Runtime = docker compose, in dev and prod.** Services: reverse proxy (auto-TLS), backend,
  opencode, egress proxy (opencode's only way to the internet: public destinations only). They share the vault clones via a compose volume. Only the proxy publishes ports. In dev,
  bind-mount the sources for hot reload rather than running anything natively; the one exception is the dev
  model, a native Ollama on the Mac shared by all dev stacks (`just ollama install`). The Docker CLI
  talks to Rancher Desktop.
- **Security:** provider API keys server-side only; opencode reachable only on the internal
  compose network (`internal: true`, password-protected), version pinned, file access restricted to the session's vault; a single-user bearer token guards all endpoints;
  HTTPS mandatory (reverse proxy with auto-TLS).

## Scope

MVP boundary = milestone **M4** (chat that reads and writes the vault, mobile, git-synced).
Out of scope: plugins, canvas, multi-user/real-time collaboration, offline AI.
Skill portability caveats (Python scripts, scraper credentials, the non-portable RTK hook and
global `~/.claude/CLAUDE.md`) are listed in `specs/system/functional.md` (Skills).

## Demo run book

Every user-visible feature also updates the demo run book: `Karpathy Demo.md` in the demo vault
`tillg/karpathy_demo_wiki` (local clone `~/git/karpathy_demo_wiki`). Add or extend the matching chapter: what the
feature does, a page in the vault that shows it, and a *Try it* step. Bump its `updated`. Do it in the same piece
of work as the feature. Push the demo vault only once the feature is released, so the guide never describes
something prod doesn't have yet.

## Parallel dev stacks

Several agents may run dev stacks on this Mac at the same time, one per checkout (main clone or
`.worktrees/<name>`). Stack N (1–9) is compose project `karpathy-app-N` on ports 80N0–80N9 (80N0 = the app,
header `karpathy #N`).

- Start a stack only with `just dev up`: it reuses this checkout's stack or takes the first free one, and
  remembers it in `tmp/dev/stack`. `just dev up N` pins one; it is refused if another checkout owns it.
- `just dev stacks` shows which stacks are free and which checkout owns the others.
- Never `down`, restart or exec into a stack another checkout owns, and never start one with raw
  `docker compose` (no hand-written port overrides in `tmp/`).
- `just e2e` and `just prodtest` target this checkout's stack automatically. Run `just dev down` when done.

## Progress messages (ntfy)

When the user asks to be informed via ntfy ("send me a ntfy", "notify me after each step"), post to the
**dev topic** `karpathy-development-…`: `curl -d "<msg>" ntfy.sh/$(cat tmp/.ntfy_dev_topic)`. If the
cache is missing: `security find-generic-password -s karpathy-ntfy-dev -w > tmp/.ntfy_dev_topic`.
Never post progress to a target's alert topic (`vault_ntfy_topic`, `karpathy-hetzner-…` /
`karpathy-local-…`): those are for monitoring alerts only. `just ntfy-topic dev` copies it to the clipboard for the phone.

## Agent skills

### Issue tracker

GitHub Issues in `tillg/karpathy.app` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
