---
title: "Autonomous run 2026-10-22: issue sweep, bug re-checks, two ToDos, v0.0.35"
created: 2026-10-22
edited: 2026-10-22
status: implemented
subtitle: "What the /autonomous run of 2026-10-22 (14:04–16:40, on karpathy-dev) did: checked every open issue against main, re-ran every bug, built #169 and #121, and released v0.0.35. Process decisions are in [DECISIONS.md](../../../DECISIONS.md)."
description: "Run report: 11 issues closed, the save_url flake found and fixed, chat error pills that name their tool, GitHub Actions on Node 24, release v0.0.35."
---

:::tldr
**11 issues closed, 30 open. Two real bugs fixed, three old flakes closed as not reproducible, both ToDo issues built. v0.0.35 is released: prod gets it with `just deploy hetzner 0.0.35` on your Mac.**

1. **Issue sweep:** only #61 (search AND + accents) was already done and is closed; #85 is partly done (commented). The other 26 non-bug issues are not built yet.
2. **Bugs:** your hunch held for the backend flakes (#161, #153, #136): 15 full suite runs up to load 60, no failure. But #162 (`save_url`) was real and not about models: Bun's stream iterator failed about 1 download in 10 on GitHub runners, prod included; fixed. #142 was a stale test; fixed. #163's fix is merged but waits for clean LLM runs (OpenRouter credit ran short).
3. **#169:** the chat's red error pill now says where the error came from: "During tool websearch: Insufficient credits" or "From the model …".
4. **#121:** every GitHub Action runs on Node 24; the deprecation warning is gone.

**Your part:** deploy v0.0.35, run `just devhost`, push the demo vault, top up OpenRouter credit, review the decisions.
:::

## What was built and fixed {#built}

::::cards
:::card{title="#169 Error pills name their source"}
When a reply fails, the red pill says which tool was running at that moment ("During tool websearch: …") or, when none was, that the model's own request failed ("From the model qwen3-8b: …"). It works live and after a reload, and the screen-reader announcement says the same. The app's own errors (a failed pull, a restarted AI service) and Stop keep their text. With several tools running at once it names the last one started; right after the backend reconnects to opencode it may say "model" until a reload.
:::

:::card{title="#121 GitHub Actions on Node 24"}
checkout, setup-node, upload/download-artifact, the docker actions and the Pages actions are bumped to the first major that runs on Node 24, each checked against its `action.yml`. CI shows no "Node.js 20 is deprecated" warning any more.
:::

:::card{title="#162 save_url downloads (real bug)"}
The AI's `save_url` tool failed about one download in ten on GitHub runners with "undefined is not a function": Bun's async iterator over a fetch body breaks when the loop awaits a file write. It now reads with `getReader()`: 0 failures in 270 probe downloads on GitHub runners, CI green.
:::

:::card{title="#142 and #163 (test fixes)"}
#142: the picture test still looked for `Ideas.md`, which since yesterday moves to `Ideas/Ideas.md` with its picture. #163: the `/research` tests read only the last message of a turn, but opencode starts a new message per step; they now read the whole turn, and the skill states its web access in a fixed sentence.
:::
::::

## Issue sweep {#sweep}

| Issue | Verdict | What happened |
| --- | --- | --- |
| #61 Search AND + accents | done | closed: on `main` since #138 |
| #85 Token, cost and context meter | partly | commented: context meter and per-vault usage exist; per-turn cost and Compact don't |
| #161, #153, #136 Backend flakes under load | not reproducible | closed: 15 full runs (sequential, parallel, load 16 and 56–60), 0 failures; no CI failure since 2026-10-08 |
| #162 `save_url` on GitHub runners | real | fixed (1108e79), closed |
| #142 Picture e2e | real (stale test) | fixed (f3c6f84), closed |
| #163 `@llm` /research tests | real (test read too little) | fix merged (f3c6f84); open until a few clean `npm run test:llm` runs |
| #137 Instagram 429 on prod | still valid | open: this Hetzner host is throttled too; waits on #168 |
| #154 BrowserCalls ↔ Vaults circular import | still valid | open: the refactor isn't small |
| #169, #121 (ToDo) | built | merged, closed |
| the other 24 enhancement / research issues | not done | untouched |

## Testing {#quality}

| Check | Result |
| --- | --- |
| `just check` on `main` (lint, typecheck, secret scan, unit suites, deploy tests) | green; two settings-CLI timeouts at load ~38 (during the flake load test) passed alone |
| E2E without `@llm`, Chromium desktop, iPad and iPhone | 268 passed; 5 failed in the batch and passed on `--last-failed` (the known busy-host flakes) |
| #169 review by a second agent | no functional bug; one comment/spec fix on opencode's event order, with a regression test |
| CI on `main` | green |
| Release v0.0.35 | see §5 |

Not run: WebKit projects and `token-scan.spec.ts` (karpathy-dev lacks WebKit's libraries, qrencode and ffmpeg until `just devhost`); a clean full `npm run test:llm` (credit).

## Release {#release}

Version **0.0.35**, tagged from `main` with `just release 0.0.35`; the release workflow builds and publishes the images. It contains everything since v0.0.34: #169, #162, #121, the #142/#163 test fixes, the quoted `just e2e` arguments, and the dev host's Ansible via pipx (`devtools` role).

Deploy on the Mac: `just deploy hetzner 0.0.35`. Rollback: `just deploy hetzner 0.0.34`.

## What you need to do {#todo}

1. **Deploy:** `just deploy hetzner 0.0.35` on the Mac.
2. **Push the demo vault** after the deploy: `~/git/karpathy_demo_wiki` on karpathy-dev has the new "When something fails" section in chapter 10 (#169).
3. **Run `just devhost`** from the Mac: gives karpathy-dev WebKit, qrencode, ffmpeg and the pipx Ansible.
4. **Top up OpenRouter credit**, then run `npm run test:llm` a few times and close #163.
5. **Review the decisions** in [DECISIONS.md](../../../DECISIONS.md) (run 2026-10-22 14:04), the two overrides first: pushing straight to `main`, and one force-push of a bug agent's own throwaway branch.
6. **Answer the #168 questions** (Instagram relay) when you get to it.

Retro: `just e2e` now passes quoted arguments through (test in `just check`); CLAUDE.md says to run `@llm` tests from one agent at a time. Drafted for the autonomous plugin, not filed: repeat the hard limits in every subagent prompt, record the default branch's CI state at the start, block shell writes to `DECISIONS.md`.

## Sources {#sources}

- GitHub issues [#169](https://github.com/tillg/karpathy.app/issues/169), [#121](https://github.com/tillg/karpathy.app/issues/121), [#162](https://github.com/tillg/karpathy.app/issues/162), [#163](https://github.com/tillg/karpathy.app/issues/163), [#142](https://github.com/tillg/karpathy.app/issues/142), [#161](https://github.com/tillg/karpathy.app/issues/161), [#153](https://github.com/tillg/karpathy.app/issues/153), [#136](https://github.com/tillg/karpathy.app/issues/136), [#137](https://github.com/tillg/karpathy.app/issues/137), [#154](https://github.com/tillg/karpathy.app/issues/154), [#85](https://github.com/tillg/karpathy.app/issues/85), [#61](https://github.com/tillg/karpathy.app/issues/61).
- [DECISIONS.md](../../../DECISIONS.md), run 2026-10-22 14:04.
- Commits `fd7d7de..` on `main`; tag `v0.0.35`.
