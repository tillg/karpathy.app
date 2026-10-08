import { describe, expect, it } from 'vitest';
import { loadSettings, resolveSecrets, secretRefs } from '../src/index.js';
import { CENTRAL, tempDir } from './helpers.js';

describe('secrets', () => {
  const dev = loadSettings('dev', { dir: tempDir({ 'settings.yaml': CENTRAL, 'dev.yaml': '{}\n' }) });
  const hetzner = loadSettings('hetzner', { dir: tempDir({ 'settings.yaml': CENTRAL, 'hetzner.yaml': 'ai: { gateway: openrouter, model: openrouter/z-ai/glm-5.3 }\n' }) });

  it('lists the references in use, with their paths', () => {
    expect(secretRefs(dev)).toEqual([
      { name: 'exa_api_key', path: 'ai.web.exa_api_key', optional: true },
      { name: 'bearer_token', path: 'auth.bearer_token', optional: false },
      { name: 'opencode_password', path: 'auth.opencode_password', optional: false },
      { name: 'github_token', path: 'git.github_token', optional: true },
      { name: 'dns_api_token', path: 'proxy.dns.api_token', optional: true },
    ]);
    expect(secretRefs(hetzner).map((r) => r.name)).toContain('openrouter_api_key');
  });

  it('resolve', () => {
    const store = tempDir({ bearer_token: 'abc\n', opencode_password: 'pw', github_token: '' });
    const values = resolveSecrets(dev, store);
    expect(values.bearer_token).toBe('abc');
    expect(values.opencode_password).toBe('pw');
    expect(values.github_token).toBeUndefined();
    expect(values.exa_api_key).toBeUndefined();
    const err = (() => { try { resolveSecrets(hetzner, store); } catch (e) { return (e as Error).message; } })();
    expect(err).toMatch(/missing secret openrouter_api_key \(gateways\.openrouter\.api_key\)/);
    expect(err).not.toContain('abc');
  });
});
