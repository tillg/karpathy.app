---
feature: central-settings-yaml
title: "Domain: settings, environments and secret references"
status: applying
order: 2
created: 2026-10-08
edited: 2026-10-08
---

# Domain: settings, environments and secret references

## New terms

| Term | Meaning |
|---|---|
| **Central settings file** | `deploy/settings/settings.yaml`, committed. Declares every app setting with the value all environments share. |
| **Environment file** | `deploy/settings/<env>.yaml`, committed. Same shape as the central file, but holds only the settings that environment overrides. Its existence defines the environment. |
| **Setting** | A value an operator chooses per environment and that the app reads at start: model, gateway, domain, TLS mode, timezone, git identity, web caps. Not changed by the app itself. |
| **Environment** | A named way the stack runs: `dev` (dev stack N on the Mac), `prodtest`, `local` (Lima VM target), `hetzner` (production target), `test` (CI and integration tests). Every **target** is an environment; not every environment is a target. |
| **Effective settings** | The central file deep-merged with the environment file and, for `dev` and `prodtest` only, the **local overlay**. Maps merge key by key; lists and scalars replace. |
| **Local overlay** | Optional, gitignored `deploy/settings/dev.local.yaml` or `deploy/settings/prodtest.local.yaml`: one developer's own choices (e.g. "use OpenRouter"). Never read for a target. Replaces hand-edited `deploy/.env`. |
| **Secret reference** | A setting value of the form `{ secret: <name> }` (optionally `optional: true`). Says *which* secret a component needs, never its value. Any string setting may be one. |
| **Secret store** | Where a secret's value lives: a directory with one file per secret name. Dev: `deploy/secrets/`. Prodtest: `tmp/prodtest/secrets/`. Target: `shared/secrets/` on the host, written from the target's Ansible Vault. |
| **Gateway** | A named way to reach LLMs: kind (`openrouter`, `anthropic`, `openai-compatible`, …), base URL, API key (a secret reference) and the models it offers with their options (e.g. OpenRouter ZDR routing). The settings choose one gateway per environment. |
| **Default model** | `ai.model` in the effective settings. Used by the backend and opencode unless overridden. |
| **Model override** | The model an admin picked in the app, stored in `config.json`. Exists only while it differs from the default model; picking the default again removes it. |
| **Rendered files** | What the renderer writes from the effective settings for components that can't read the settings file: compose `.env`, `opencode.env`, the opencode provider config, and the backend's `settings.json`. Generated, never edited, never committed. |

## Settings vs. state vs. policy

Three kinds of configuration exist; only the first moves into the settings file.

```mermaid
flowchart TB
  subgraph S["Settings: chosen per environment, read at start"]
    s1[model, gateway]
    s2[domain, TLS, timezone]
    s3[git identity, remote base]
    s4[web caps, secret references]
  end
  subgraph R["Runtime state: written by the app"]
    r1[vaults list]
    r2[model override, GitHub token from Admin]
    r3[aiTouched, edit stamps, queued prompts]
  end
  subgraph P["Policy: versioned with the code, same everywhere"]
    p1[opencode agents and permissions]
    p2[egress allow rules]
    p3[Caddy headers, CSP]
  end
  S -->|deploy/settings/| F[(central file +<br/>environment files)]
  R -->|config.json on the config volume| C[(volume)]
  P -->|baked into images| I[(images)]
```

The **model** spans the first two: the settings file holds the default, `config.json` holds an optional
override. The **GitHub token** too: the secret reference names the deployment's token, and a token set
in Admin (runtime state) still wins, as today.

## Model precedence

```mermaid
flowchart LR
  D[effective settings<br/>ai.model] --> E{override in<br/>config.json?}
  E -- no --> U[model used]
  E -- yes --> O[override] --> U
  A[Admin picks a model] -->|= default| X[remove override]
  A -->|≠ default| Y[store override]
```

Before: after the first Admin save the persisted model won forever, whatever the deployment said.
After: a deployment's default change reaches every user without an override.

## Who uses which part

```mermaid
flowchart LR
  F[deploy/settings/settings.yaml] --> L[load, merge,<br/>validate]
  FE[deploy/settings/ENV.yaml] --> L
  LO[deploy/settings/ENV.local.yaml<br/>dev/prodtest only] --> L
  L --> RS{resolve secret<br/>references}
  SS[(secret store)] --> RS
  RS --> B[backend<br/>settings.json]
  RS --> CE[compose .env]
  RS --> OE[opencode.env<br/>API keys]
  RS --> OP[opencode provider<br/>config]
  RS --> SF[secret files<br/>for compose secrets]
  Op[operator / developer] -->|edits| F
  Op -->|just settings show env| L
  An[Ansible role app] -->|calls the renderer| L
  Dv[dev.sh, just prodtest] -->|calls the renderer| L
```

## Changed terms

- **Target** (deployment.md): unchanged meaning; its *app* settings now come from the central file plus
  `deploy/settings/<target>.yaml`. The inventory keeps host provisioning and the vault (secret store).
- **`default_model` / `DEFAULT_MODEL`**: replaced by `ai.model`. `DEFAULT_MODEL` is still written to the
  rendered `.env` so an older release's `compose.yml` keeps working on rollback.
- **`deploy/.env`, `deploy/opencode.env`**: no longer edited by hand; generated by the renderer.
