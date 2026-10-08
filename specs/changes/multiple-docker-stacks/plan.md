---
feature: multiple-docker-stacks
title: "Plan: numbered dev stacks"
status: applied
order: 4
created: 2026-10-08
edited: 2026-10-08
---

# Plan: numbered dev stacks

Each step is one red → green cycle. Nothing is mocked. Test layers:

- **Shell unit:** `deploy/stack.test.sh` is plain bash with `assert` helpers and no framework, run by
  `bash deploy/stack.test.sh` and added to `just check`. Pure functions get canned `docker compose ls` JSON as
  input (real format, captured 2026-10-08). Functions that touch Docker run against the real daemon, read-only.
- **e2e unit:** `e2e/stack.unit.ts` runs with `node --experimental-strip-types --test e2e/stack.unit.ts` (Node 22).
  The `.unit.ts` name keeps it out of Playwright's `*.spec|test.ts` match.
- **Compose:** `docker compose … config` renders the merged file without starting anything.
- **Acceptance:** real stacks, real ports.

## Stack library

- [x] `stack_ports N` exports the port block and project name; rejects N ∉ 1–9
  - Depends on: none
  - Test first: `deploy/stack.test.sh` › "stack 3 → 8030/8031/8032/8035, project karpathy-app-3" and "stack 0 and
    10 are rejected". Fails today: neither `deploy/stack.sh` nor the test harness exists.
  - Verify: `bash deploy/stack.test.sh` → all assertions pass, exit 0
- [x] `stack_owner_in JSON N` reads the owning checkout from `docker compose ls -a --format json`
  - Depends on: 1
  - Test first: `deploy/stack.test.sh` › "owner of karpathy-app-2 is /x/.worktrees/a" (JSON with two projects,
    one `ConfigFiles` list holding three files), "no project → empty", "karpathy-app-20 does not match stack 2".
    Fails today: no function.
  - Verify: `bash deploy/stack.test.sh` → exit 0
- [x] `stack_state` and `stack_resolve [ARG] [--new]` resolve N in the order arg → `$STACK` → `tmp/dev/stack` →
  first free (only with `--new`)
  - Depends on: 2
  - Test first: `deploy/stack.test.sh` › "arg beats STACK beats remembered", "no remembered stack without --new →
    exit 1 with 'run just dev up'", "--new skips a stack whose 80N0 is bound" (the test binds 8090 with
    `nc -l` itself, which is real, not a fake). Each case uses its own temp checkout dir. Fails today: no
    functions.
  - Verify: `bash deploy/stack.test.sh` → exit 0

## Compose

- [x] `compose.dev.yml` takes the stack's ports, gets per-project image names and the shared Ollama models volume
  - Depends on: none
  - Test first: none, because this is config only. The Verify check renders the merged config.
  - Verify: `cd deploy && PROXY_PORT=8020 BACKEND_PORT=8021 OLLAMA_PORT=8022 docker compose -p karpathy-app-2 -f
    compose.yml -f compose.dev.yml config | grep -E '"?8020"?|127.0.0.1:8021|127.0.0.1:8022|HMR_CLIENT_PORT: "8020"|karpathy-app-ollama-models'`
    matches all five, `… config --images` lists `karpathy-app-2-backend`, `-opencode` and `-egress`, and without
    `PROXY_PORT` the same `config` exits non-zero with "start dev stacks with just dev up"
- [x] `compose.prodtest.yml` pairs with stack N: port 80N5, bridge to `karpathy-app-N-ollama-1`, network
  `karpathy-app-N_internal`
  - Depends on: none
  - Test first: none, because this is config only.
  - Verify: `cd deploy && STACK=2 PRODTEST_PORT=8025 docker compose -p karpathy-app-2-prodtest -f compose.yml -f
    compose.prodtest.yml config | grep -E '8025|karpathy-app-2-ollama-1|karpathy-app-2_internal'` matches all three

## Commands

- [x] `deploy/dev.sh up [N] | down | logs | ps | token | stacks` drives stack N through `stack.sh`; `up` refuses a
  foreign or port-busy stack
  - Depends on: 3, 4
  - Test first: `deploy/stack.test.sh` › "dev.sh stacks prints 9 lines with https://localhost:80N0" (real Docker,
    read-only) and "dev.sh up N refuses a stack owned by another checkout". The second case starts a real
    one-service project `karpathy-app-9` (`alpine sleep`, from a temp checkout's `deploy/compose.yml`), expects
    the refusal to name that checkout, then runs `down` on it. Fails today: `dev.sh` knows no stacks.
  - Verify: `bash deploy/stack.test.sh` → exit 0; `just dev stacks` → 9 lines
- [x] `justfile`: `dev` passes the stack argument, `prodtest` resolves the stack (80N5, `karpathy-app-N-prodtest`),
  and `check` runs `deploy/stack.test.sh`
  - Depends on: 5, 6
  - Test first: none, because the recipes only wire up tested parts. The Verify check uses `just --dry-run`.
  - Verify: `just --dry-run prodtest up 2>&1 | grep -q 'STACK_PROJECT-prodtest'` (a shebang recipe's dry run
    prints the script, not the expanded name) and `just check` → green,
    including the shell tests
- [x] e2e targets the remembered stack: `e2e/stack.ts` resolves `E2E_BASE_URL` → `STACK` →
  `tmp/dev/stack`, and `helpers.ts`, `playwright.config.ts` and `global-setup.ts` use it
  - Depends on: none
  - Test first: `e2e/stack.unit.ts` › "STACK=3 → https://localhost:8030 and karpathy-app-3-backend-1",
    "remembered 2 when STACK unset", "E2E_BASE_URL wins and is kept as-is", "nothing set → throws 'run just dev
    up'". Fails today: no `e2e/stack.ts`.
  - Verify: `node --experimental-strip-types --test e2e/stack.unit.ts` → pass; `npm run typecheck && npm run
    lint` → green; `rg -n "8443|karpathy-app-backend-1" e2e playwright.config.ts` → only the prod default in
    `e2e/stack.ts` (used when `E2E_BASE_URL` targets a deployed stack without `E2E_BACKEND_CONTAINER`)

- [x] The header brand shows `karpathy #N` on dev stack N (`VITE_STACK`), and `karpathy.app` without one
  - Depends on: 4
  - Test first: `apps/web/src/lib/brand.test.ts` › "'2' → 'karpathy #2'", "undefined / '' / '0' / 'x' →
    'karpathy.app'". Fails today: no `brand.ts`.
  - Verify: `npm test -w apps/web -- brand` → pass; `npm run typecheck && npm run lint` → green; `cd deploy &&
    STACK=2 PROXY_PORT=8020 BACKEND_PORT=8021 OLLAMA_PORT=8022 docker compose -p karpathy-app-2 -f compose.yml -f
    compose.dev.yml config | grep -q 'VITE_STACK: "2"'`

## Found while applying (2026-10-08)

- [x] A stack remembered by another worktree of the repo is claimed (`other:<worktree>`) before its containers
  exist, and `just dev down` releases it
  - Depends on: 6
  - Test first: `deploy/stack.test.sh` › "stack N remembered by another worktree is claimed", "first free skips
    the claimed stack", "… but it is mine in that worktree". Fails today: ownership is read from Docker only, and
    `compose up --build` builds for minutes before any container exists, so a second `just dev up` took the same
    stack (seen in the first acceptance run).
  - Verify: `bash deploy/stack.test.sh` → exit 0
- [x] `stack_state` reports `port-busy` when **any** port the stack publishes (80N0, 80N1) is bound by something
  else
  - Depends on: 3
  - Test first: `deploy/stack.test.sh` › "a bound 80N1 makes stack N port-busy". Fails today: only 80N0 is probed.
    Seen in the first acceptance run: something on the Mac outside Docker holds 8021, so stack 2's backend port
    never forwarded.
  - Verify: `bash deploy/stack.test.sh` → exit 0
- [x] `just ollama install|uninstall|status`: native Ollama on the Mac as a LaunchAgent (`127.0.0.1:11434`,
  `OLLAMA_CONTEXT_LENGTH=16384`)
  - Depends on: none
  - Test first: none, because this is machine setup. The Verify check reads the running service.
  - Verify: `just ollama install && just ollama status` → running; `curl -sf 127.0.0.1:11434/api/version` → 200;
    `launchctl print gui/$(id -u)/app.karpathy.ollama | grep -q OLLAMA_CONTEXT_LENGTH`
- [x] Dev and prodtest stacks use the native Ollama: the `ollama` service becomes a socat relay to
  `host.docker.internal:11434`; no Ollama container, port 80N2 or models volume; `dev.sh up` requires a running
  Ollama and pulls the model on the Mac. This replaces the Ollama parts of steps 1, 4 and 5 (`OLLAMA_PORT`, the
  models volume, the bridge to the dev stack's Ollama).
  - Depends on: 6, 12
  - Test first: `deploy/stack.test.sh` › "stack_ollama_ready is false for a dead URL and true for
    127.0.0.1:11434" and "stack 3 exports no OLLAMA_PORT". Fails today: no function, and `stack_ports` still
    exports 8032.
  - Verify: `bash deploy/stack.test.sh` → exit 0; `docker compose … config --images` for dev and prodtest lists
    `alpine/socat` and no `ollama/ollama`; `config | grep -c OLLAMA_PORT` → 0

## Acceptance

- [x] Two checkouts run stacks side by side, and e2e and prodtest each hit their own stack
  - Depends on: 7, 8, 9, 10, 11, 13
  - Test first: the steps below, which fail today because a second `just dev up` reuses `karpathy-app` on 8443.
    Throwaway worktree: `git worktree add .worktrees/stack-check HEAD`.
    1. Main checkout: `just dev up` → stack N1. Worktree: `just dev up` → a different stack N2.
    2. `curl -skf https://localhost:80N10/api/health` and `…:80N20/api/health` → both 200;
       `curl -sf http://127.0.0.1:80N11/api/health` (backend, no TLS) → 200.
    3. In the worktree, `just dev up N1` → refused, naming the main checkout.
    3b. On each stack, opencode reaches the native Ollama through the relay: in the opencode container,
        `wget -Y off -qO- http://ollama.internal:11434/api/tags` lists `qwen2.5:3b` (the name changed during
        this run; see architecture, Ollama relay).
    4. `just e2e version.spec.ts attach.spec.ts` in each checkout → green, and attach is **not** skipped.
    5. `just prodtest up && just prodtest e2e version.spec.ts` in the main checkout → green on 80N15.
    6. HMR: edit a string in `apps/web/src` in the worktree and see it appear on 80N20 without a reload
       (Playwright screenshot in `tmp/`, read before claiming it).
    7. The header reads `karpathy #N1` on 80N10 and `karpathy #N2` on 80N20 (Playwright screenshots of
       `[data-testid=vault-switcher]` at 1×, read), and `karpathy.app` on the prodtest port 80N15.
  - Verify: all seven checks pass. Then `just dev down` in the worktree, `git worktree remove .worktrees/stack-check`,
    and `just prodtest down`.

## Docs

- [x] `CLAUDE.md` gets the "Parallel dev stacks" section; `README.md`, `deploy/README.md` and the 8443 comments
  (`justfile`, `vite.config.ts`, `lima/karpathy-vm.yaml`, `compose.prodtest.yml` header) describe stacks; README
  and the CLAUDE.md runtime line name the native dev Ollama (`just ollama install`)
  - Depends on: 7, 13
  - Test first: none, because these are docs only.
  - Verify: `rg -n "8443" -g '!specs/**' -g '!DECISIONS*' -g '!*.html' -g '!node_modules' .` → no match;
    `rg -n "just dev stacks" CLAUDE.md README.md deploy/README.md` → a match in each

## Review fixes (adversarial code review, 2026-10-08)

- [x] CI renders `compose.dev.yml` with stack 1's variables
  - Depends on: none
  - Test first: none, because this is CI config. The Verify check runs the CI step locally.
  - Verify: the CI step's command with its new env (`STACK=1 PROXY_PORT=8010 BACKEND_PORT=8011`) → exit 0
- [x] `e2e/plan-gaps.spec.ts` targets this checkout's stack (`docker compose -p <project>`), and accepts the
  backend's loopback-only debug port
  - Depends on: none
  - Test first: `e2e/stack.unit.ts` › "STACK=3 → project karpathy-app-3". Fails today: `stackTarget` returns no
    project. Then `just e2e plan-gaps.spec.ts --grep-invert @llm` fails today on stack 1 (compose without `-p`).
  - Verify: both green on stack 1
- [x] `dev.sh down|logs|ps` refuse a stack this checkout doesn't own, and `down` deletes `tmp/dev/stack` only if
  it holds that number; a stack whose owning checkout is gone is `orphan` and `up` may take it over
  - Depends on: none
  - Test first: `deploy/stack.test.sh` › "dev.sh down N refuses a stack owned by another checkout" and "a stack
    whose checkout was deleted is orphan". The fixture project uses the first free stack, not a fixed 9, and
    asserts that its `up` succeeded. Fails today: `down` has no owner check, and no `orphan` state exists.
  - Verify: `bash deploy/stack.test.sh` → exit 0
- [x] Prodtest remembers its own stack (`tmp/prodtest/stack`), so `just prodtest down` works after
  `just dev down`; the busy-port probe includes 80N5
  - Depends on: none
  - Test first: `deploy/stack.test.sh` › "a bound 80N5 makes stack N port-busy". Fails today: 80N5 isn't probed.
  - Verify: `bash deploy/stack.test.sh` → exit 0; `just prodtest up`, `just dev down`, `just prodtest down` → the
    prodtest project is gone
- [x] The Ollama relay passes only the OpenAI-compatible API (`/v1/*`) to the native Ollama, not its admin API
  (pull, delete, create): a small Caddy instead of raw socat, shared by dev and prodtest
  - Depends on: none
  - Test first: acceptance-style check in the opencode container: `wget -Y off http://ollama.internal:11434/api/tags`
    → 403 and `…/v1/models` → 200. Fails today: socat passes `/api/tags` (200).
  - Verify: both checks; `just e2e chat.spec.ts -g "AI write"` with `ollama/qwen2.5:3b` → green
- [x] Hardening: `stack.sh` stops with a hint without `jq`, without Docker, or outside a git checkout;
  `just ollama install` refuses when another server already holds 11434 and fails when its own never answers; the
  model check uses `ollama show`; the Ollama test skips when no native Ollama runs; `e2e/stack.unit.ts` runs in
  `just check`
  - Depends on: none
  - Test first: `deploy/stack.test.sh` › "stack_root outside a git checkout fails with a hint". Fails today:
    `cd ""` succeeds silently.
  - Verify: `just check` → green; `cd /tmp && bash -c 'source <repo>/deploy/stack.sh; stack_root'` → non-zero with
    the hint
- [x] Spec and docs: the domain's relay name, the step 7 Verify line, README on what `just check` needs, the
  broken comment in `e2e/helpers.ts`
  - Depends on: none
  - Test first: none, because these are docs only.
  - Verify: `rg -n "forwarding .ollama:11434" specs/changes/multiple-docker-stacks` → no match

Note: the running `karpathy-app` (8443), `karpathy-graph` and `karpathy-outline` projects belong to the user and
other agents. Taking them down is the user's call after merge (`docker compose -p <name> down`), not a plan step.

System docs are updated at `/spec:archive`.
