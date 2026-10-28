# Every model instruction is a Markdown file in prompts/, never a string in code; tool descriptions stay with the tool

Text the app writes to tell a model what to do lives as one `.md` file per instruction in `prompts/` at the repo root (#149). That covers an agent's system prompt, the hidden parts of a turn, the request of a one-shot task and the default question to the vision model. The body is the exact text the model receives, sent verbatim (no Markdown rendering, no rewrapping). Optional YAML frontmatter holds only `variables`, the `{{name}}` placeholders. Code loads a file with `prompt('<name>')` from `prompts/load.ts`, the one loader for the backend (Node, `yaml`) and opencode's `lib/` (Bun, `Bun.YAML`; the image copies the directory to `/opt/prompts`). It reads at module load and refuses missing, undeclared or unused variables, so a broken prompt stops the backend or fails the opencode image build. Agent prompts in `opencode.json` use opencode's `{file:/opt/prompts/agents/<id>.md}`. These files have no frontmatter, and the agent stays in the managed config, the layer a vault can't override.

**File names:** the folder says who uses a file (`agents/`, the root for the backend and opencode's `lib/`). The name is the agent id, otherwise the topic in kebab-case.

**Not prompt files:**
- **tool descriptions** (a tool's `description` and its argument `.describe(…)` texts). They are part of the tool's definition and stay in `deploy/opencode/tools/<id>.ts`, next to the signature and the code. We moved them to `prompts/tools/` first and moved them back: what a tool is told to do and how it is called belong together;
- tool output (results, errors, refusals, the md-lint report), which is data about a call;
- app skills, which stay in `deploy/opencode/skills/<name>/SKILL.md` where opencode discovers them.

**Where the line is:** a variable's value may carry its own small formatting (`', locale de-DE'`, `kind: path` lines, `[diff truncated]`), but never a sentence that tells the model what to do. Templates have no logic.

**Rejected:**
- inline strings, which scatter the text the model sees;
- a `prompts/` per runtime;
- generated TypeScript, which is a second copy;
- a template library;
- model parameters in frontmatter, since settings stay in `deploy/settings/`;
- runtime or vault overrides;
- opencode Markdown agents, which leave the managed config.

**Guard and re-check:** `apps/backend/test/prompts-guard.test.ts` fails on these:
- a `prompts/tools/` directory, or a tool that calls `prompt()`;
- a non-`{file:}` agent prompt;
- an unused prompt file;
- a string literal over 120 characters passed to the prompt API.

`prompt-texts.test.ts` checks that the opencode image serves the agent prompt file. A new model-facing text outside a tool definition means a new prompt file. Editing one, or a tool description, puts `npm run test:llm` in its Verify.
