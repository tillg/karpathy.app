import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { loadSettings, renderBackendSettings, renderComposeEnv, renderOpencodeEnv, renderOpencodeProviders } from '../src/index.js';
import { backendSettingsSchema } from '../../../apps/backend/src/settings.js';
import { tempDir } from './helpers.js';

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const env = (text: string) => parseEnv(text) as Record<string, string>;

const SECRETS = {
  bearer_token: 'bearer-SECRET',
  opencode_password: 'pw-SECRET',
  github_token: 'gh-SECRET',
  dns_api_token: 'key:dns-SECRET',
  openrouter_api_key: 'sk-or-#1 "x"',
  git_author_name: 'Jane Doe',
  git_author_email: 'jane@example.com',
};

describe('renderOpencodeProviders', () => {
  it("reproduces today's provider configs", () => {
    expect(renderOpencodeProviders(loadSettings('dev', { overlay: false }))).toEqual({ provider: JSON.parse(fixture('dev-ollama.json')).provider });
    expect(renderOpencodeProviders(loadSettings('hetzner', { overlay: false }))).toEqual(JSON.parse(fixture('opencode-openrouter.json')));
  });
});

describe('renderOpencodeEnv', () => {
  it('gateway key, Exa, caps, model', () => {
    const hetzner = env(renderOpencodeEnv(loadSettings('hetzner', { overlay: false }), SECRETS));
    const { OPENCODE_CONFIG_CONTENT, ...rest } = hetzner;
    expect(rest).toEqual({
      OPENROUTER_API_KEY: 'sk-or-#1 "x"',
      WEB_FETCH_CAP: '20',
      WEB_SEARCH_CAP: '20',
      OPENCODE_MODEL: 'openrouter/z-ai/glm-5.3',
    });
    // The providers, merged after a vault's own opencode.json.
    expect(JSON.parse(OPENCODE_CONFIG_CONTENT!)).toEqual(renderOpencodeProviders(loadSettings('hetzner', { overlay: false })));
    expect(env(renderOpencodeEnv(loadSettings('hetzner', { overlay: false }), { ...SECRETS, exa_api_key: 'exa' })).EXA_API_KEY).toBe('exa');
    const dev = env(renderOpencodeEnv(loadSettings('dev', { overlay: false }), {}));
    expect(Object.keys(dev).sort()).toEqual(['OPENCODE_CONFIG_CONTENT', 'OPENCODE_MODEL', 'WEB_FETCH_CAP', 'WEB_SEARCH_CAP']);
  });

  it('names the key variable after the gateway kind', () => {
    const dir = tempDir({
      'settings.yaml': readFileSync(new URL('../../../deploy/settings/settings.yaml', import.meta.url), 'utf8'),
      'x.yaml': 'gateways: { anthropic: { kind: anthropic, api_key: { secret: anthropic_api_key } } }\nai: { gateway: anthropic, model: anthropic/claude-x }\n',
    });
    expect(env(renderOpencodeEnv(loadSettings('x', { dir }), { anthropic_api_key: 'a' })).ANTHROPIC_API_KEY).toBe('a');
  });
});

describe('renderComposeEnv', () => {
  it('keeps every legacy key', () => {
    const hostFacts = ['APP_VERSION', 'DEPLOYED_AT', 'BIND_IP', 'HTTPS_PORT', 'APP_UID', 'APP_GID'];
    const legacy = fixture('env.j2.keys').trim().split('\n');
    const rendered = Object.keys(env(renderComposeEnv(loadSettings('hetzner', { overlay: false }), SECRETS)));
    expect(legacy.filter((k) => !hostFacts.includes(k) && !rendered.includes(k))).toEqual([]);
  });

  it('values for hetzner and dev', () => {
    const hetzner = env(renderComposeEnv(loadSettings('hetzner', { overlay: false }), SECRETS));
    expect(hetzner).toMatchObject({
      DOMAIN: 'app.karpathy.app',
      TLS_MODE: 'dns',
      DNS_PROVIDER: 'godaddy',
      TZ: 'Europe/Berlin',
      DEFAULT_MODEL: 'openrouter/z-ai/glm-5.3',
      GIT_AUTHOR_NAME: 'Jane Doe',
      GIT_AUTHOR_EMAIL: 'jane@example.com',
      GIT_REMOTE_BASE: 'https://github.com/',
    });
    expect(hetzner.OLLAMA_UPSTREAM).toBeUndefined();
    expect(hetzner.SETTINGS_DIR).toBeUndefined();
    const dev = env(renderComposeEnv(loadSettings('dev', { overlay: false }), {}, { settingsDir: '../tmp/settings/dev' }));
    expect(dev).toMatchObject({ OLLAMA_UPSTREAM: 'host.docker.internal:11434', SETTINGS_DIR: '../tmp/settings/dev', GIT_AUTHOR_NAME: 'Dev User' });
  });
});

describe('OLLAMA_UPSTREAM', () => {
  it('where the relay finds Ollama, only for the ollama gateway', () => {
    expect(env(renderComposeEnv(loadSettings('dev', { overlay: false }), {})).OLLAMA_UPSTREAM).toBe('host.docker.internal:11434');
    expect(env(renderComposeEnv(loadSettings('local', { overlay: false }), {})).OLLAMA_UPSTREAM).toBe('192.168.5.2:11434');
    expect(env(renderComposeEnv(loadSettings('hetzner', { overlay: false }), SECRETS)).OLLAMA_UPSTREAM).toBeUndefined();
  });
});

describe('renderBackendSettings', () => {
  it('credentials become /run/secrets paths, other references are resolved', () => {
    const json = renderBackendSettings(loadSettings('hetzner', { overlay: false }), SECRETS);
    const s = JSON.parse(json);
    expect(s.auth).toEqual({ bearer_token: { file: '/run/secrets/bearer_token' }, opencode_password: { file: '/run/secrets/opencode_password' } });
    expect(s.git).toEqual({
      remote_base: 'https://github.com/',
      author: { name: 'Jane Doe', email: 'jane@example.com' },
      github_token: { file: '/run/secrets/github_token' },
    });
    expect(s.ai).toEqual({ model: 'openrouter/z-ai/glm-5.3', web_access: true });
    expect(s.commit_reminder_threshold).toBe(4);
    expect(s.files).toEqual({ visible_dot_dirs: ['.agents'] });
    for (const e of ['dev', 'prodtest', 'test', 'local', 'hetzner'])
      expect(() => backendSettingsSchema.parse(JSON.parse(renderBackendSettings(loadSettings(e, { overlay: false }), SECRETS))), e).not.toThrow();
    for (const name of ['bearer_token', 'opencode_password', 'github_token', 'dns_api_token', 'openrouter_api_key'])
      expect(json).not.toContain(SECRETS[name as keyof typeof SECRETS]);
  });
});
