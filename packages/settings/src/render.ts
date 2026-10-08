import type { Settings } from './schema.js';

type Secrets = Record<string, string | undefined>;

/** Secrets the compose stack mounts as files (/run/secrets/<name>); every other reference is resolved inline. */
const COMPOSE_SECRETS = ['bearer_token', 'opencode_password', 'github_token', 'dns_api_token'];

/** opencode reads a provider's key from this variable. */
const KEY_VARS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const isRef = (v: unknown): v is { secret: string } => typeof v === 'object' && v !== null && 'secret' in v;

/** A string setting's value: itself, or its secret's value. */
function text(v: string | { secret: string }, secrets: Secrets): string {
  return isRef(v) ? (secrets[v.secret] ?? '') : v;
}

/** One `KEY=value` line that compose's env-file parser reads back verbatim. */
function line(key: string, value: string): string {
  if (/^[\w./:@+,-]*$/.test(value)) return `${key}=${value}`;
  if (!value.includes("'") && !value.includes('\n')) return `${key}='${value}'`;
  // Compose expands $ inside double quotes; $$ is a literal $.
  return `${key}=${JSON.stringify(value).replaceAll('$', '$$$$')}`;
}

const lines = (entries: [string, string | undefined][]) =>
  entries.filter((e): e is [string, string] => e[1] !== undefined).map(([k, v]) => line(k, v)).join('\n') + '\n';

/** opencode's `provider` config for the chosen gateway (OPENCODE_CONFIG_CONTENT in opencode.env). */
export function renderOpencodeProviders(s: Settings): { provider: Record<string, unknown> } {
  const gw = s.gateways[s.ai.gateway]!;
  const provider =
    gw.kind === 'openai-compatible'
      ? { npm: '@ai-sdk/openai-compatible', ...(gw.name ? { name: gw.name } : {}), options: { baseURL: gw.base_url }, models: gw.models ?? {} }
      : { ...(gw.models ? { models: gw.models } : {}) };
  return { provider: { [s.ai.gateway]: provider } };
}

/**
 * opencode.env: the gateway's API key, Exa, the web caps, the default model and the gateway's provider config.
 * The providers go in OPENCODE_CONFIG_CONTENT, which opencode merges after a vault's own opencode.json (an
 * OPENCODE_CONFIG file comes before it): a vault can't turn off the ZDR routing or redirect the gateway.
 */
export function renderOpencodeEnv(s: Settings, secrets: Secrets): string {
  const gw = s.gateways[s.ai.gateway]!;
  const keyVar = KEY_VARS[gw.kind];
  return lines([
    ...(keyVar && gw.api_key ? [[keyVar, secrets[gw.api_key.secret]] as [string, string | undefined]] : []),
    ['EXA_API_KEY', s.ai.web.exa_api_key ? secrets[s.ai.web.exa_api_key.secret] : undefined],
    ['WEB_FETCH_CAP', String(s.ai.web.fetch_cap)],
    ['WEB_SEARCH_CAP', String(s.ai.web.search_cap)],
    ['OPENCODE_MODEL', s.ai.model],
    ['OPENCODE_CONFIG_CONTENT', JSON.stringify(renderOpencodeProviders(s))],
  ]);
}

/**
 * The compose `.env`. Keeps every key the pre-settings `env.j2` wrote (a rollback runs an older release's
 * compose.yml); a target appends its host facts (APP_VERSION, BIND_IP, …). `settingsDir` is the rendered
 * directory relative to the compose project dir, for dev and prodtest.
 */
export function renderComposeEnv(s: Settings, secrets: Secrets, { settingsDir }: { settingsDir?: string } = {}): string {
  const gw = s.gateways[s.ai.gateway]!;
  return lines([
    ['DOMAIN', s.proxy.domain],
    ['TLS_MODE', s.proxy.tls],
    ['DNS_PROVIDER', s.proxy.dns.provider],
    ['TZ', s.timezone],
    ['GIT_AUTHOR_NAME', text(s.git.author.name, secrets)],
    ['GIT_AUTHOR_EMAIL', text(s.git.author.email, secrets)],
    ['GIT_REMOTE_BASE', s.git.remote_base],
    ['DEFAULT_MODEL', s.ai.model],
    ['OLLAMA_UPSTREAM', gw.relay_upstream],
    ['SETTINGS_DIR', settingsDir],
  ]);
}

/** The backend's settings.json: what the backend needs, credentials as compose secret files. */
export function renderBackendSettings(s: Settings, secrets: Secrets): string {
  const ref = (r: { secret: string } | undefined) => {
    if (!r) return undefined;
    if (!COMPOSE_SECRETS.includes(r.secret)) throw new Error(`secret ${r.secret} is not a compose secret`);
    return { file: `/run/secrets/${r.secret}` };
  };
  const backend = {
    auth: { bearer_token: ref(s.auth.bearer_token), opencode_password: ref(s.auth.opencode_password) },
    git: {
      remote_base: s.git.remote_base,
      author: { name: text(s.git.author.name, secrets), email: text(s.git.author.email, secrets) },
      github_token: ref(s.git.github_token),
    },
    ai: { model: s.ai.model, web_access: s.ai.web.access },
    commit_reminder_threshold: s.commit_reminder_threshold,
    files: s.files,
  };
  return JSON.stringify(backend, null, 2) + '\n';
}

/** The ingest service's config (ingest.json → /etc/ingest/config.json): profiles with their secrets resolved. */
export function renderIngestConfig(s: Settings, secrets: Secrets): string {
  const profiles = Object.fromEntries(Object.entries(s.ingest?.profiles ?? {}).map(([name, p]) => [name, {
    vault: p.vault,
    ...(p.root ? { root: p.root } : {}),
    label: p.label,
    account: text(p.account, secrets),
    allowed_senders: p.allowed_senders.map((a) => text(a, secrets)),
    ...p.settings,
  }]));
  return JSON.stringify({ defaults: s.ingest?.defaults ?? {}, profiles }, null, 2) + '\n';
}
