---
feature: central-settings-yaml
title: "Plan: one central settings file"
status: applying
order: 4
created: 2026-10-08
edited: 2026-10-08
---

# Plan: one central settings file

Each step is one red → green cycle. Nothing is mocked: renderers are pure functions tested on fixture
settings; compose is tested with `docker compose config`; the backend with real files.

Test layers:

- **Settings units:** vitest in `packages/settings/test/*.test.ts`: `npm test -w packages/settings -- <file>`.
- **Backend units:** vitest in `apps/backend/test/`: `npm test -w apps/backend -- <file>`.
- **Stack:** `bash deploy/stack.test.sh` (compose config, dev scripts).
- **e2e:** Playwright against this checkout's dev stack (`just dev up`): `just e2e <spec>`.
- **Full check:** `just check` (lint, typecheck, all unit and integration tests, stack tests).

Phases 1–2 add the package and file without changing behavior; phase 3 switches the backend; phase 4
the stacks; phase 5 Ansible. Each phase leaves `just check` green and the dev stack working.

## Phase 1: the settings package

- [x] Create `packages/settings` with a trivial passing test
  - Test first: `packages/settings/test/load.test.ts` › "package runs" asserts `typeof loadSettings ===
    'function'`. Fails today: the package doesn't exist.
  - Verify: `npm test -w packages/settings` → green; `just check` → green (the workspace picks it up).

- [x] `loadSettings` merges `settings.yaml` ← `<env>.yaml`
  - Test first: `load.test.ts` › "maps merge, scalars and lists replace". Fixture dir with
    `settings.yaml` (`ai = { gateway: a, model: a/x, web: { fetch_cap: 20 } }`) and `dev.yaml` (`ai = {
    model: a/y, web: { search_cap: 5 } }`), a list in both. Expects merged `ai`, `fetch_cap` kept, list
    replaced; `environments(dir)` → `['dev']`. Fails today: `loadSettings` returns nothing.
  - Verify: `npm test -w packages/settings -- load` → green.

- [x] The local overlay applies to dev and prodtest only
  - Test first: `load.test.ts` › "dev.local.yaml overlays dev, never a target". `dev.local.yaml` sets
    `ai.model`; `loadSettings('dev')` takes it; a missing overlay is fine; a `hetzner.local.yaml` makes
    `loadSettings('hetzner')` fail ("local overlays apply to dev and prodtest only"). Fails today: overlay
    not read.
  - Verify: `npm test -w packages/settings -- load` → green.

- [x] Schema rejects unknown keys, bad types and unknown environments with file and YAML path
  - Test first: `packages/settings/test/schema.test.ts` › "errors name file and path". `ai.modle` in
    `dev.yaml` → error containing `dev.yaml: ai.modle`; `timezone: 5` → type error with path; a central
    file missing a required key fails even though an environment file sets it (the central file must be
    complete); an environment file may omit any key; `loadSettings('staging')` → "unknown environment
    staging (dev, hetzner, local, prodtest, test)". Fails today: no schema.
  - Verify: `npm test -w packages/settings -- schema` → green.

- [x] Cross-field rules: gateway exists, model belongs to it, `tls: dns` needs a DNS token
  - Test first: `schema.test.ts` › "cross-field rules". `ai.gateway: nope` → error; `ai.gateway: ollama,
    ai.model: ollama/llama9` (not listed) → error naming the gateway's models; `ai.gateway: anthropic` (kind
    with built-in models) + any `anthropic/…` → ok; `proxy.tls: dns` without `proxy.dns.api_token` → error.
    Fails today: none of these are checked.
  - Verify: `npm test -w packages/settings -- schema` → green.

- [x] Secret references: list them and resolve them from a store directory
  - Test first: `packages/settings/test/secrets.test.ts` › "resolve". A temp store dir with `bearer_token`
    (`abc\n`) and an empty `github_token`. `secretRefs` lists every ref with its path; `resolveSecrets`
    returns `abc` (one trailing newline trimmed); the empty optional `github_token` → `undefined`; a missing
    required `openrouter_api_key` → error listing the name *and* path, never a value; a ref name `../x` →
    schema error. Fails today: module missing.
  - Verify: `npm test -w packages/settings -- secrets` → green.

## Phase 2: the file and the renderers

- [x] Write `deploy/settings/settings.yaml` and the five environment files with today's values
  - Test first: `packages/settings/test/repo-settings.test.ts` › "today's effective values". Loads the
    real `deploy/settings/` directory and asserts per environment the values from the inventory: hetzner model
    `openrouter/z-ai/glm-5.3`, domain `app.karpathy.app`, tls `dns`, timezone `Europe/Berlin`, git author
    as secret refs; local `ollama/qwen2.5:3b`, `file:///remotes/`, author `karpathy.app local`; dev and
    prodtest Ollama + `file:///remotes/`; test model and vision model. Also: each environment file is
    minimal (no key repeats the central value; a value equal to the central one is an error, so a
    later change to the central file isn't silently masked). Fails today: no `deploy/settings/`.
  - Verify: `npm test -w packages/settings -- repo-settings` → green.

- [x] `renderOpencodeProviders` reproduces today's provider configs
  - Test first: `packages/settings/test/render.test.ts` › "providers". For the `ollama` gateway the
    output deep-equals the `provider` object of today's `deploy/opencode/dev-ollama.json` (copied into
    `test/fixtures/` before the file is deleted); for `openrouter` it deep-equals the `provider` block of
    `deploy/opencode/opencode.json`. Fails today: renderer missing.
  - Verify: `npm test -w packages/settings -- render` → green.

- [x] `renderOpencodeEnv`: gateway key, Exa, caps, model
  - Test first: `render.test.ts` › "opencode.env". openrouter gateway + key `k` → `OPENROUTER_API_KEY=k`;
    anthropic → `ANTHROPIC_API_KEY`; ollama → no key line; Exa only when resolved; `WEB_FETCH_CAP=20`,
    `WEB_SEARCH_CAP=20`, `OPENCODE_MODEL=<ai.model>`. Values with `#`, spaces or quotes are quoted so
    compose reads them back verbatim (asserted by parsing with `docker compose config` in a later stack
    test). Fails today: renderer missing.
  - Verify: `npm test -w packages/settings -- render` → green.

- [x] `renderComposeEnv` is a superset of today's `env.j2` keys
  - Test first: `render.test.ts` › "compose .env keeps every legacy key". Parses the key names from
    `deploy/ansible/roles/app/templates/env.j2` (copied to `test/fixtures/env.j2.keys` before `env.j2` is
    deleted in phase 5) and asserts that the rendered `.env` plus the host facts Ansible appends (`APP_VERSION`,
    `DEPLOYED_AT`, `BIND_IP`, `HTTPS_PORT`, `APP_UID`, `APP_GID`) cover all of them; values for hetzner:
    `DEFAULT_MODEL=openrouter/z-ai/glm-5.3`, `TLS_MODE=dns`, `TZ=Europe/Berlin`; names JSON-quoted as
    `env.j2` did. Fails today: renderer missing.
  - Verify: `npm test -w packages/settings -- render` → green.

- [x] `renderBackendSettings` replaces secret refs with `/run/secrets` paths
  - Test first: `render.test.ts` › "backend settings.json has no secret values". Output parses with the
    schema's backend variant; `auth.bearer_token` = `{ file: "/run/secrets/bearer_token" }`; the resolved
    secret values from the test store appear nowhere in the JSON string. Fails today: renderer missing.
  - Verify: `npm test -w packages/settings -- render` → green.

- [x] CLI `render`, `show`, `check`, `--list-secrets`, and `just settings`
  - Test first: `packages/settings/test/cli.test.ts` › "CLI". Spawns `node packages/settings/src/cli.ts`:
    `render dev --out <tmp> --secrets <store>` writes the four files (`opencode.env` mode 0600) and exits 0;
    a missing required secret exits 1 naming it; `show hetzner` prints refs like `{ secret: bearer_token }`
    and no store values; `check` exits 0 for the repo file and 1 for a broken fixture;
    `--list-secrets hetzner` prints one name per line. Fails today: CLI missing.
  - Verify: `npm test -w packages/settings -- cli` → green; `just settings check` → exit 0; `just check` →
    green (`settings check` added to `check` and to `ci.yml`).

## Phase 3: backend

- [x] `loadBackendSettings` reads `settings.json` and its secret files
  - Test first: `apps/backend/test/settings.test.ts` › "loads settings.json". Temp dir with a rendered
    `settings.json` whose secret refs point at temp files; returns token, remote base, identity, default
    model, opencode password, `files.visible_dot_dirs`; a missing file or invalid JSON throws with the path; `visible_dot_dirs`
    containing `.git` or a name without a leading `.` is a schema error. Fails today: function missing.
  - Verify: `npm test -w apps/backend -- settings` → green.

- [x] `main.ts` takes its settings from `SETTINGS_FILE`, not env
  - Test first: none for `main.ts` itself (process entry, no harness); the previous step covers
    `loadBackendSettings`. Existing `api.test.ts`, `config-store.test.ts`, `git.test.ts` pass before and
    after.
    Also: `listFiles` in `vaults.ts` passes `settings.files.visible_dot_dirs` to `listTree` instead of
    the constant `DEFAULT_VISIBLE_DOT_DIRS` (added by the `.agents` file-tree work), and the constant is
    deleted; its existing `files.test.ts` / `api.test.ts` cases pass before and after.
  - Verify: `rtk grep -n "GIT_REMOTE_BASE\|GIT_AUTHOR\|DEFAULT_MODEL\|BEARER_TOKEN\|GITHUB_TOKEN\|OPENCODE_PASSWORD\|DEFAULT_VISIBLE_DOT_DIRS" apps/backend/src`
    → no match; `just check` → green.

- [x] Model default vs. override in `ConfigStore`
  - Test first: `apps/backend/test/config-store.test.ts` › "override only while it differs".
    (a) open with default `d1`, no file → model `d1`, no `modelOverride` persisted; (b) set override `m2`,
    reopen with default `d3` → `m2`; (c) set model back to default → `modelOverride` removed from the file;
    (d) reopen with default `d4` after (c) → `d4`; (e) a legacy file with `settings.model = d1` and default
    `d1` → no override; legacy `settings.model = m2` → `modelOverride: m2`. Fails today: (d) gives `d1`,
    legacy model is kept as `model`.
  - Verify: `npm test -w apps/backend -- config-store` → green; `just check` → green.

- [x] Settings API: `defaultModel`, `modelOverridden`, `model: null` resets
  - Test first: `apps/backend/test/api.test.ts` › "settings model default and override". `GET
    /api/settings` → `{ model: d, defaultModel: d, modelOverridden: false }`; `PATCH { model: m2 }` →
    overridden; `PATCH { model: null }` → back to `d`; `PATCH` with an unknown model still 400. Fails
    today: fields and `null` not accepted.
  - Verify: `npm test -w apps/backend -- api` → green; `just check` → green.

- [x] Admin model picker: "Default (model)" entry and reset
  - Test first: `e2e/admin.spec.ts` › "model picker shows the default and resets an override". Opens
    Admin, sees `Default (ollama/qwen2.5:3b)` selected; picks another listed model, saves, reloads → that
    model, marked as override; picks the default entry, saves → no override (asserted via `GET
    /api/settings`). Fails today: no default entry. Also runs on `@iphone`.
  - Verify: `just e2e e2e/admin.spec.ts` → green; `just check` → green. Demo run book chapter "Model" in
    `~/git/karpathy_demo_wiki/Karpathy Demo.md` updated (`updated` bumped; pushed only at release).

## Phase 4: dev, prodtest and tests render from the file

- [x] Compose reads the rendered directory; no model or gateway literal left in compose files or
  `opencode.json` (its `provider` block moves to the `openrouter` gateway)
  - Test first: `deploy/stack.test.sh` › "compose uses rendered settings". Renders `dev` into a temp dir
    with a test store, runs `docker compose -f compose.yml -f compose.dev.yml --env-file <tmp>/.env config`:
    backend mounts `settings.json` and has `SETTINGS_FILE`; opencode has `env_file` = the rendered
    `opencode.env` and `OPENCODE_CONFIG` pointing at the mounted providers file; `OPENROUTER_API_KEY`
    with a `#` in it survives verbatim. Same for prodtest. Fails today: compose has no `SETTINGS_DIR`.
  - Verify: `bash deploy/stack.test.sh` → all ok; `rtk grep -n "qwen\|claude-sonnet\|glm-5" deploy/*.yml` → no match.

- [x] `dev.sh up` and `just prodtest up` render first; legacy files stop them
  - Test first: `stack.test.sh` › "dev up renders and guards legacy files". With a fake `docker` on
    `PATH` recording its args: `dev.sh up` calls the renderer, then compose with
    `--env-file ../tmp/settings/dev/.env`; with a `deploy/.env` present it exits 1 and the message names
    the keys found (`DEFAULT_MODEL`) but no values; a missing required secret exits 1 before compose.
    Fails today: dev.sh doesn't render.
  - Verify: `bash deploy/stack.test.sh` → all ok; `just dev up` → stack starts; `just e2e
    e2e/chat.spec.ts` → green (chat answers with the Ollama model from the file).

- [x] Delete `dev-ollama.json`, `.env.example`, `opencode.env.example`; migrate this Mac's dev files
  - Test first: none — file removal and a one-time manual migration (the current `deploy/.env` model goes
    to `deploy/settings/dev.local.yaml`, the key in `deploy/opencode.env` to `deploy/secrets/openrouter_api_key`).
  - Verify: `rtk grep -rn "dev-ollama\|opencode.env.example\|\.env\.example" deploy justfile README.md specs/system` →
    no match; `.gitignore` has `deploy/settings/*.local.yaml` and `tmp/` (already); `just dev up` → green; `just
    prodtest && just prodtest e2e e2e/version.spec.ts` → green.

- [x] Integration tests take their default models from the `test` environment
  - Test first: `apps/backend/test/opencode-container.test.ts` › "default test models come from
    deploy/settings/test.yaml" asserts the exported defaults equal `loadSettings('test').ai.model` / `.vision_model`
    and that `LLM_TEST_MODEL` still overrides. Fails today: defaults are literals.
  - Verify: `npm test -w apps/backend -- opencode-container` → green; `npm run test:llm` → green (needs
    Ollama); `rtk grep -rn "qwen2.5:3b\|qwen3-vl:2b" --include=*.ts --include=*.yml --include=*.sh . | grep -v '^./deploy/settings/' | grep -v node_modules`
    → no match outside tests' fixtures (dev.sh's `ollama pull` reads the model from `settings show dev`).

## Phase 5: Ansible renders from the file

- [x] Prove a container in the Lima VM reaches the Mac's Ollama
  - Test first: none — a reachability probe, no code yet. It decides `relay_upstream` in `local.yaml`.
  - Verify: `limactl shell karpathy-vm -- docker run --rm curlimages/curl -sf -H 'Host: localhost:11434' http://192.168.5.2:11434/api/version`
    → prints Ollama's version. If it fails, find the address that works (Lima docs for `vmType: vz`),
    put it in `deploy/settings/local.yaml` and the architecture, and re-run.

- [x] The Ollama relay takes its upstream from the settings
  - Test first: `render.test.ts` › "OLLAMA_UPSTREAM": `.env` for dev has
    `OLLAMA_UPSTREAM=host.docker.internal:11434`, for local the `relay_upstream` from `local.yaml`, for
    hetzner (openrouter gateway) no such line. `stack.test.sh` › "relay upstream": `docker compose config`
    of dev passes `OLLAMA_UPSTREAM` to the relay. Fails today: the Caddyfile hard-codes the host.
  - Verify: `npm test -w packages/settings -- render` → green; `bash deploy/stack.test.sh` → all ok;
    `just dev up` → `just e2e e2e/chat.spec.ts` green.

- [x] Role `app` renders on the controller and copies the files to `shared/`
  - Test first: `deploy/stack.test.sh` › "ansible render task". Runs the role's render script
    (`deploy/ansible/render-settings.sh <target> <outdir>`, the wrapper the task calls) against
    `inventories/local` with its test vault: produces `.env`, `opencode.env`, `opencode-providers.json`,
    `settings.json`; the temp secret dir is gone afterwards, also when the renderer fails. Fails today:
    the wrapper doesn't exist.
  - Verify: `bash deploy/stack.test.sh` → all ok; `cd deploy/ansible && ansible-lint && ansible-playbook -i inventories/local --vault-id local@vault-pass-client.sh --syntax-check site.yml` → ok.

- [x] Every secret a target's settings use has a source in role `app` (vault layout unchanged, see
  DECISIONS.md run 2026-10-08 18:39)
  - Test first: `stack.test.sh` › "every secret in the settings has a source in role app": each name
    `settings --list-secrets <target>` prints is named in `roles/app/vars/main.yml`, is a provider key
    from `vault_opencode_env`, or is `opencode_password` (generated on the host).
  - Verify: `bash deploy/stack.test.sh` → all ok; `ansible-lint` → ok.

- [x] Remove `env.j2`, the opencode.env task and the app keys from `group_vars`
  - `compose.target.yml.j2`: gate the `/remotes` mount on `remotes_dir is defined` (stays in `local`
    group_vars as host plumbing) and drop its `GIT_REMOTE_BASE` env (the backend reads it from
    `settings.json`).
  - Test first: existing render golden test (`.env` ⊇ legacy keys) passes before and after.
  - Verify: `rtk grep -rn "default_model\|tls_mode\|^git_author\|^opencode_env" deploy/ansible/inventories deploy/ansible/roles` → no match
    (the vault's own `vault_git_author_*` / `vault_opencode_env` stay);
    `ansible-playbook … --syntax-check` for both inventories → ok; `just check` → green.

- [x] `local` runs the Ollama relay; role `app` checks the Mac's Ollama first
  - Test first: `stack.test.sh` › "target relay only for the ollama gateway". Renders
    `compose.target.yml.j2` (via `ansible -m template` on localhost) for `local` and `hetzner`:
    `local` has the relay service, `OLLAMA_UPSTREAM` and `NO_PROXY=…,ollama.internal`; `hetzner` has
    none of them. Fails today: the template has no relay.
  - Verify: `bash deploy/stack.test.sh` → all ok; `ansible-lint` → ok; with `just ollama uninstall`,
    `just deploy local …` stops with "run `just ollama install`" (then reinstall).

- [ ] Deploy to `local` and roll back to the previous release
  - Test first: none — end-to-end on the VM, no harness beyond the smoke check.
  - Verify: cut `vX.Y.Z-rc.1`, `just deploy local X.Y.Z-rc.1` → smoke check green, `just e2e` against
    local green, including `e2e/chat.spec.ts` (the AI answers through the Mac's Ollama); `just deploy local <previous release> --only app` → smoke check green (rollback with the
    new playbook); `just deploy local X.Y.Z-rc.1 --only app` again → green.

## Phase 6: docs and single source

- [x] README, `deploy/README.md`, `CLAUDE.md` (architecture bullet) describe the `deploy/settings/` files
  - Test first: none — docs.
  - Verify: `rtk grep -n "deploy/settings/settings.yaml\|dev.local.yaml" README.md deploy/README.md` → matches; `rtk grep -rn "deploy/.env\b\|opencode.env.example" README.md deploy/README.md CLAUDE.md` → no match.

- [x] Model and gateway literals live only in `deploy/settings/`
  - Test first: `repo-settings.test.ts` › "model literals live only in deploy/settings/" walks the tracked
    files (`git ls-files`, excluding `specs/`, `DECISIONS.md`, `node_modules`, test fixtures) and asserts
    `openrouter/z-ai/glm-5.3`, `qwen2.5:3b`, `qwen3-vl:2b` and `ollama.internal:11434/v1` occur only in
    `deploy/settings/*.yaml`, and `anthropic/claude-sonnet-5` (today's code default) occurs nowhere. Fails today:
    they are in 9 files.
  - Verify: `npm test -w packages/settings -- repo-settings` → green; `just check` → green.

System docs are updated at `/spec:archive`.
