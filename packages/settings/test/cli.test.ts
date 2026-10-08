import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './helpers.js';

const root = new URL('../../../', import.meta.url).pathname;
const cli = (...args: string[]) => {
  const r = spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'packages/settings/src/cli.ts'), ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('settings CLI', () => {
  it('render writes the four files', () => {
    const out = tempDir();
    const store = tempDir({ bearer_token: 'tok-SECRET', opencode_password: 'pw' });
    const r = cli('render', 'dev', '--out', out, '--secrets', store, '--compose-dir', join(out, '..'));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const f of ['.env', 'opencode.env', 'opencode-providers.json', 'settings.json']) expect(readFileSync(join(out, f), 'utf8')).not.toBe('');
    expect(statSync(join(out, 'opencode.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(out, '.env'), 'utf8')).toContain(`SETTINGS_DIR=${out.split('/').pop()}`);
    expect(r.out).not.toContain('tok-SECRET');
  });

  it('a missing required secret fails and names it', () => {
    const r = cli('render', 'hetzner', '--out', tempDir(), '--secrets', tempDir({ bearer_token: 't', opencode_password: 'p' }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing secret dns_api_token (proxy.dns.api_token)');
  });

  it('show prints references, never values', () => {
    const r = cli('show', 'hetzner');
    expect(r.code).toBe(0);
    expect(r.out).toContain('bearer_token: { secret: bearer_token }');
    expect(r.out).toContain('model: openrouter/z-ai/glm-5.3');
  });

  it('check validates every environment', () => {
    expect(cli('check').code).toBe(0);
    const broken = tempDir({ 'settings.yaml': 'ai: {}\n', 'dev.yaml': '{}\n' });
    const r = cli('check', '--dir', broken);
    expect(r.code).toBe(1);
    expect(r.err).toContain('settings.yaml: ai.gateway');
  });

  it('--list-secrets prints one name per line', () => {
    const r = cli('--list-secrets', 'hetzner');
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n').sort()).toEqual(
      ['bearer_token', 'dns_api_token', 'exa_api_key', 'git_author_email', 'git_author_name', 'github_token', 'opencode_password', 'openrouter_api_key'],
    );
  });
});
