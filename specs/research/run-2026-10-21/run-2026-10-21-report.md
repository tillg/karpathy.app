---
title: "Autonomous run 2026-10-21: five features, review fixes, release"
created: 2026-10-21
edited: 2026-10-21
status: implemented
subtitle: "What the /autonomous run of 2026-10-21 (19:19–23:45, on karpathy-dev) built for issues #155, #141, #138, #92 and #91, what the review found and fixed, the #168 proposal, and the feature decisions to review. Process decisions are in [DECISIONS.md](../../../DECISIONS.md)."
description: "Run report: chat type-ahead, secret scan, smart search, local graph, Bases tables; 20 review fixes; release v0.0.34; Instagram relay proposal."
---

:::tldr
**All five issues are built, reviewed, fixed and on `main`; v0.0.34 is released. Prod gets it with `just deploy hetzner 0.0.34` on your Mac.**

1. **Type ahead while the AI works (#155):** messages sent to a busy chat wait as "Queued" bubbles on the server and go out by themselves; Edit, ✕ and Stop hand them back.
2. **Secret scan before Commit & Push (#141, #167):** gitleaks checks every committed file's content and the message; a finding blocks the commit, "Commit anyway" overrides exactly what was shown. The AI's commit-message proposal no longer sees secrets.
3. **Smart search (#138):** a ranked BM25 index with accent folding, stemming per note language and typo tolerance; `handtuch` finds "Handtücher".
4. **Local graph (#92):** Local | Wiki | All in the graph pane; the open note's neighbourhood at depth 1 or 2, flat, with names.
5. **Bases tables (#91):** a ` ```base ` block renders a live, read-only table in Obsidian Bases syntax, in Read and Write mode.

An adversarial review then found **20 defects** (3 high); all were fixed test-first before the release. #168 got a change proposal, not code.

**Your part:** deploy (`just deploy hetzner 0.0.34`), renew the dev host's GitHub token, run `just devhost`, push the demo vault, answer the #168 questions, and review the decisions in §3.
:::

## What was built {#built}

::::cards
:::card{title="#155 Type ahead while the AI works"}
The composer never locks. A prompt sent to a busy chat joins a server-side queue (up to 10 per chat, in order, kept across reloads and devices) and shows as a dashed **Queued** bubble with Edit and ✕. When the reply ends, the next one starts by itself. **Stop** ends the reply and puts every queued message back into the box, oldest first, so nothing runs you didn't want.
:::

:::card{title="#141 Secret scan before Commit & Push"}
gitleaks 8.30.1 (pinned, checksum-verified) scans the stored content of every changed file, binary files included, plus the commit message. A finding blocks the commit and names file, line and rule, showing at most four characters. **Commit anyway** covers exactly the findings shown; `.gitleaksignore` (read from the last commit) handles lasting false positives. Unpushed commits the app didn't scan are scanned before a push. This repo's `just check` and CI scan its history too.
:::

:::card{title="#138 Smart search"}
An in-memory index per vault (MiniSearch, BM25) replaces ripgrep. Case and accents fold (German `ue` = `ü`), words are stemmed in the note's language (de, en, fr, es, it; detected locally or from `lang:`), file names and headings rank higher, the last word matches as a prefix, and a word with a typo still finds its note. Matched words are highlighted even when spelled differently.
:::

:::card{title="#92 Local graph"}
**Local graph** at the foot of the outline opens the graph pane on the open note's neighbourhood: its links and backlinks at depth 1 or 2, every link between them, flat and with names, same colours and legend as the vault graph. The pane switches **Local | Wiki | All**.
:::

:::card{title="#91 Bases tables"}
A fenced ` ```base ` block (Obsidian Bases syntax) shows a live, read-only table of matching notes, in Read mode and in Write mode's live preview. Filters on folders, tags, frontmatter and dates; table view with columns, sort, limit and names. Tables refresh when notes change; rows open notes; `.base` files open as tables. Unsupported syntax says "not supported in v1".
:::

:::card{title="#168 Instagram (proposal)"}
A browser can't fetch instagram.com. The proposal `specs/changes/instagram-mac-relay/` routes only Instagram's traffic from the ingest service through a small proxy on your Mac, so Instagram sees your home IP. Five open questions are in the issue.
:::
::::

## Review and testing {#quality}

Every feature was built test-first by its own agent in its own worktree, with unit tests, e2e specs and updated `specs/system/` pages. After the merge:

| Check | Result |
| --- | --- |
| `just check` on the final `main` (lint, typecheck, secret scan, every unit suite, deploy tests) | green: 36 + 66 + 670 + 383 tests |
| E2E of the new features plus regressions (Chromium desktop and iPhone) | 39 passed; the `@llm` chat-title test failed in the batch and passed twice alone (known: its tests share one vault) |
| Exploratory test with many German, English and French notes, light and dark, phone width | all five features worked; one local-graph bug found and fixed (a single note showed an empty canvas) |
| Adversarial review of the whole run | 20 findings, all fixed test-first and merged |
| Release v0.0.34 | built and published: every job green after one re-run of `check` (the known intermittent #162, `save_url`) |

The review findings that mattered most:

- **Chat queue:** a failed pull could drop another queued prompt; a message sent just before Stop could still run; a message queued as a reply ended could hang at "Waiting…".
- **Secret scan:** binary files, `-diff` files and a same-commit `.gitleaksignore` entry bypassed it; some gitleaks errors read as a clean scan.
- **Search:** a long query froze the server for seconds; a symlink could expose files outside the vault; file names and extensions weren't found.
- **Bases and graph:** deep nesting crashed with a 500; tables could stay stale; link queries took 36 s on 5,000 notes (now 0.45 s); a new note had no local graph.

## Feature decisions to review {#decisions}

The decisions about functionality, with their ids in [DECISIONS.md](../../../DECISIONS.md). All are `open`.

| Feature | Decision | Main alternative |
| --- | --- | --- |
| #155 | Queue on the server, behind the running turn; the AI sees a queued message after its current reply (-8) | Inject into the running opencode turn, as Claude Code does |
| #155 | Stop and Edit hand queued messages back into the composer; at most 10 per chat (-9) | Keep the queue after Stop |
| #141 | gitleaks over stored file contents; fail closed; files over 50 MB need "Commit anyway" (-6, -17) | Scan only the text diff |
| #141 | "Commit anyway" for the exact findings shown, plus `.gitleaksignore` from HEAD; inline allows and vault configs ignored (-7, -17) | Hard block without override |
| #138 | MiniSearch BM25 in memory, Snowball stems per note language, franc-min detection, no LLM (-10) | SQLite FTS5, an on-disk index |
| #138 | Score order changes three old search tests (-11) | Keep path order |
| #138 | Words match from their start; `tuch` doesn't find "Handtuch" (-18) | Substring fallback |
| #92 | Local scope of the existing graph pane, flat 2D, opened from the outline (-12) | A second graph renderer; a note-bar button |
| #91 | Backend evaluates a strict v1 subset of Bases; table view only; 500 rows (-13) | Lenient parsing; client-side evaluation |
| #91 | In Write mode the table replaces the block until the cursor goes in (-14) | Table under the visible YAML |
| #168 | Mac relay for Instagram traffic; no fallback to the server IP (-20) | Scraper on the Mac; residential proxy |

## What you need to do {#todo}

1. **Deploy:** on the Mac, `just deploy hetzner 0.0.34` (rollback: `just deploy hetzner 0.0.33`). karpathy-dev can't: the Ansible vault password is only in your Keychain.
2. **Renew the dev host's GitHub token:** at 22:24 git dropped it from `~/.git-credentials` on karpathy-dev, most likely because GitHub rejected it. `just secrets dev`, then `just devhost`; that also installs WebKit, qrencode and ffmpeg (this run's retro fix).
3. **Push the demo vault** after the deploy: `~/git/karpathy_demo_wiki` on karpathy-dev has five unpushed run-book commits and a new page `Wiki/topics/dashboards.md`.
4. **Answer the #168 questions**, then `/spec:apply instagram-mac-relay`.
5. **Review the decisions** in §3 (and the process ones in DECISIONS.md).

Still open: #162 (intermittent `save_url` test on CI); the chat-title e2e test shares one vault with its neighbours; WebKit e2e hasn't run on karpathy-dev yet; Bases speed has no automated guard; gitleaks' rules skip images and archives.

## Sources {#sources}

- GitHub issues [#155](https://github.com/tillg/karpathy.app/issues/155), [#141](https://github.com/tillg/karpathy.app/issues/141), [#138](https://github.com/tillg/karpathy.app/issues/138), [#92](https://github.com/tillg/karpathy.app/issues/92), [#91](https://github.com/tillg/karpathy.app/issues/91), [#167](https://github.com/tillg/karpathy.app/issues/167), [#168](https://github.com/tillg/karpathy.app/issues/168).
- [DECISIONS.md](../../../DECISIONS.md), run 2026-10-21 19:19.
- `specs/system/` (functional, architecture, domain, security) as updated on `main`.
- Commits `8696615..8c301c7` on `main`; tag `v0.0.34`.
