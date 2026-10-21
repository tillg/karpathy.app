---
feature: prompts-as-md-files
title: "Proposal: AI prompts as .md files"
status: applied
order: 1
created: 2026-10-21
edited: 2026-10-21
---

# Proposal: AI prompts as .md files

**Issue:** [#149](https://github.com/tillg/karpathy.app/issues/149)

## Why

The instructions the app gives the model are spread over TypeScript string literals and one JSON
value. They sit in three backend modules, the vision helper, `opencode.json` and eight tool files.
To read or tune what the model is told, you have to know where each one hides, and you have to edit
code to change it. Prompt work is the main tuning knob for small models, and the `@llm` tests often
fail for prompt reasons, so this matters a lot. The issue asks for one place, one file per prompt,
and an ADR so the rule sticks.

## What changes

- **One directory, `prompts/` at the repo root.** Every model-facing instruction text is one `.md`
  file in it, except tool descriptions (see below). The only structured data is the list of
  template variables, in YAML frontmatter.
- **One small loader, `prompts/load.ts`.** It reads a file once, at module load, and fills in
  `{{variable}}` placeholders. It refuses a missing, unknown or unused variable. Both runtimes use the
  same loader: the backend (Node) and the opencode container (Bun).
- **Every prompt in scope moves to its own file.** The model receives byte-identical text, so this is
  a refactor with no behavior change. A characterization test proves it.
- **ADR 0006** records the rule: model-facing instruction text lives in `prompts/*.md` and never as an
  inline string. A guard test enforces it mechanically.

### In scope (agreed: "instructions to the model")

| Prompt | Today | New file |
|---|---|---|
| Commit-message agent's system prompt | `opencode.json` → `agent.commit-message.prompt` | `prompts/agents/commit-message.md` |
| Commit-message request (files, stat, diff) | `apps/backend/src/commit-message.ts` | `prompts/commit-message-request.md` |
| Local-time line | `apps/backend/src/harness/local-time.ts` | `prompts/local-time.md` |
| Command-turn wrapper around the skill text | `apps/backend/src/harness/command.ts` | `prompts/command-turn.md` |
| Default vision question | `deploy/opencode/lib/look-at-image.ts` | `prompts/look-at-image-question.md` |

### Out of scope

- **Tool descriptions and argument descriptions** (decided 2026-10-21, after apply). They are part
  of a tool's definition, so they stay in `deploy/opencode/tools/<id>.ts` next to the signature and
  the code. `SAVE_URL_DESCRIPTION` stays in `lib/save-url.ts`. They were moved to `prompts/tools/` at
  first and then moved back.
- **Tool output text**, which a tool *returns* to the model as data: the md-lint "Fix them now"
  report, the known-url refusals, and the result and error messages of `save_url` and `open_page`.
  These are tool results, not instructions. The ADR names them as the line.
- **Chat titles.** Our code makes none with an LLM. `titleFromFirstPrompt` copies the first prompt,
  and opencode's internal title agent uses opencode's own prompt. The issue's example doesn't exist in
  our code.
- **Skills and vault instructions.** The app skill `deploy/opencode/skills/research/SKILL.md` is
  already Markdown, and opencode discovers it there. A vault's `AGENTS.md`, `CLAUDE.md` and skills
  belong to the vault.
- **Rewording any prompt.** Better prompts come later, and they will be easy once the prompts live
  in files.
- **Rewrapping.** Bodies stay verbatim: a one-paragraph prompt stays on one line.
- **Model parameters** (`max_tokens`, temperature, model) in prompt files. They stay in code or in
  `deploy/settings/`.
- **Runtime overrides.** There is no admin setting and no vault override for a prompt; prompts change
  through git and a deploy.
- **Dev hot reload of tool prompts.** It needs an opencode image rebuild, like tool code today.
  Follow-up idea: bind-mount `prompts/` into the dev opencode container and restart it.

```mermaid
flowchart LR
  subgraph today[Today: strings in code]
    T[tools/*.ts<br/>descriptions] --> OC[opencode]
    J[opencode.json<br/>agent prompt] --> OC
    B[backend .ts<br/>local time, command, commit] --> OC
    V[lib/look-at-image.ts<br/>vision question] --> VM[vision model]
  end
  subgraph after[After: prompts/*.md]
    P[(prompts/)] --> L[prompts/load.ts]
    T2[tools/*.ts<br/>descriptions stay] --> OC2[opencode]
    L --> B2[backend] --> OC2
    L --> V2[look_at_image] --> VM2[vision model]
    P -- "{file:…}" --> J2[opencode.json]
  end
```

## Tests that change by design

The temporary golden fixture of the characterization test is removed at the end (plan, step 11).
`suggest-next-tool.test.ts` and `save-url.test.ts` were moved to the prompt files for a while.
They are back at `HEAD`, because the tool descriptions stayed in code.

## Expected outcome

- `ls prompts/` lists every instruction the app gives a model outside the tool definitions, and
  editing one is a Markdown edit.
- Every existing test stays green, including `npm run test:llm`, with no change to the text the
  model sees.
- A long inline prompt string in the backend, an unused prompt file, a non-`{file:}` agent prompt or
  a `prompts/tools/` directory fails `just check`.
- ADR 0006 is in `docs/adr/`.
