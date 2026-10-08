import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { environments, loadSettings, SETTINGS_DIR } from '../src/index.js';

const yaml = (name: string) => parse(readFileSync(join(SETTINGS_DIR, name), 'utf8')) as Record<string, unknown>;

/** Leaves of `over` whose value equals the same path in `base`, as dotted paths. */
function repeated(base: unknown, over: unknown, path = ''): string[] {
  if (typeof over === 'object' && over !== null && !Array.isArray(over) && !('secret' in over))
    return Object.entries(over).flatMap(([k, v]) =>
      repeated(typeof base === 'object' && base !== null ? (base as Record<string, unknown>)[k] : undefined, v, path ? `${path}.${k}` : k),
    );
  return JSON.stringify(base) === JSON.stringify(over) ? [path] : [];
}

describe('deploy/settings', () => {
  it('has the five environments', () => {
    expect(environments()).toEqual(['dev', 'hetzner', 'local', 'prodtest', 'test']);
  });

  it("today's effective values", () => {
    const hetzner = loadSettings('hetzner', { overlay: false });
    expect(hetzner.ai).toMatchObject({ gateway: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
    expect(hetzner.proxy).toMatchObject({ domain: 'app.karpathy.app', tls: 'dns', dns: { provider: 'godaddy', api_token: { secret: 'dns_api_token' } } });
    expect(hetzner.timezone).toBe('Europe/Berlin');
    expect(hetzner.git.remote_base).toBe('https://github.com/');
    expect(hetzner.git.author).toEqual({ name: { secret: 'git_author_name' }, email: { secret: 'git_author_email' } });
    expect(hetzner.ai.web).toMatchObject({ access: true, fetch_cap: 20, search_cap: 20 });

    const local = loadSettings('local', { overlay: false });
    expect(local.ai).toMatchObject({ gateway: 'ollama', model: 'ollama/qwen2.5:3b' });
    expect(local.git).toMatchObject({ remote_base: 'file:///remotes/', author: { name: 'karpathy.app local', email: 'local@karpathy.app' } });
    expect(local.proxy).toMatchObject({ domain: 'localhost', tls: 'internal' });
    expect(local.timezone).toBe('Europe/Berlin');

    for (const env of ['dev', 'prodtest']) {
      const s = loadSettings(env, { overlay: false });
      expect(s.git.remote_base).toBe('file:///remotes/');
      expect(s.proxy.tls).toBe('internal');
    }
    expect(loadSettings('dev', { overlay: false }).git.author).toEqual({ name: 'Dev User', email: 'dev@example.com' });
    expect(loadSettings('prodtest', { overlay: false }).git.author).toEqual({ name: 'karpathy.app user', email: 'user@karpathy.app' });

    const test = loadSettings('test', { overlay: false });
    expect(test.ai).toMatchObject({ gateway: 'ollama', model: 'ollama/qwen2.5:3b', vision_model: 'ollama/qwen3-vl:2b' });
  });

  it('environment files only hold what differs from settings.yaml', () => {
    const central = yaml('settings.yaml');
    for (const env of environments()) expect(repeated(central, yaml(`${env}.yaml`)), `${env}.yaml`).toEqual([]);
  });

  it('model literals live only in deploy/settings/', () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
      // History and tests (their fixtures name models on purpose) are not settings.
      .filter((f) => !/^(specs\/|DECISIONS\.md$|deploy\/settings\/)/.test(f) && !/(\.test\.(ts|sh)|\.spec\.ts)$|(^|\/)test\//.test(f));
    const only = ['openrouter/z-ai/glm-5.3', 'qwen2.5:3b', 'qwen3-vl:2b', 'ollama.internal:11434/v1', 'anthropic/claude-sonnet-5'];
    const hits = files.flatMap((f) => {
      let text: string;
      try { text = readFileSync(root + f, 'utf8'); } catch { return []; }
      return only.filter((lit) => text.includes(lit)).map((lit) => `${f}: ${lit}`);
    });
    expect(hits).toEqual([]);
  });
});
