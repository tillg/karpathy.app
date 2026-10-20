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
  it('real ingest profiles only on hetzner: dev and test stacks never read a real Gmail label', () => {
    for (const env of ['dev', 'prodtest', 'test']) expect(loadSettings(env, { overlay: false }).ingest?.profiles, env).toEqual({});
  });

  it('has the four environments', () => {
    expect(environments()).toEqual(['dev', 'hetzner', 'prodtest', 'test']);
  });

  it("today's effective values", () => {
    const hetzner = loadSettings('hetzner', { overlay: false });
    expect(hetzner.ai).toMatchObject({ gateway: 'openrouter', model: 'openrouter/z-ai/glm-5.3', vision_model: 'openrouter/mistralai/mistral-medium-3-5' });
    // The vision model is routed like the chat model: ZDR providers only.
    expect(hetzner.gateways.openrouter!.models!['mistralai/mistral-medium-3-5']).toEqual({
      options: { provider: { order: ['mistral/zdr', 'mistral'], only: ['mistral/zdr', 'mistral'], zdr: true, data_collection: 'deny' } },
    });
    expect(hetzner.proxy).toMatchObject({ domain: 'app.karpathy.app', tls: 'dns', dns: { provider: 'godaddy', api_token: { secret: 'dns_api_token' } } });
    expect(hetzner.timezone).toBe('Europe/Berlin');
    expect(hetzner.git.remote_base).toBe('https://github.com/');
    expect(hetzner.git.author).toEqual({ name: { secret: 'git_author_name' }, email: { secret: 'git_author_email' } });
    expect(hetzner.ai.web).toMatchObject({ access: true, fetch_cap: 20, search_cap: 20 });

    // Dev and prodtest run on the production OpenRouter models (every test does, 2026-10-16).
    for (const env of ['dev', 'prodtest']) {
      const s = loadSettings(env, { overlay: false });
      expect(s.ai).toMatchObject({ gateway: 'openrouter', model: hetzner.ai.model, vision_model: hetzner.ai.vision_model });
      expect(s.git.remote_base).toBe('file:///remotes/');
      expect(s.proxy.tls).toBe('internal');
    }
    expect(loadSettings('dev', { overlay: false }).git.author).toEqual({ name: 'Dev User', email: 'dev@example.com' });
    expect(loadSettings('prodtest', { overlay: false }).git.author).toEqual({ name: 'karpathy.app user', email: 'user@karpathy.app' });

    // The tests' model: the production models on OpenRouter.
    const test = loadSettings('test', { overlay: false });
    expect(test.ai).toMatchObject({ gateway: 'openrouter', model: 'openrouter/z-ai/glm-5.3', vision_model: 'openrouter/mistralai/mistral-medium-3-5' });
    expect(test.ai).toMatchObject({ model: loadSettings('hetzner', { overlay: false }).ai.model, vision_model: loadSettings('hetzner', { overlay: false }).ai.vision_model });
    // One model source: OpenRouter is the only gateway.
    expect(Object.keys(test.gateways)).toEqual(['openrouter']);
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
    const only = ['openrouter/z-ai/glm-5.3', 'mistralai/mistral-medium-3-5', 'anthropic/claude-sonnet-5'];
    const hits = files.flatMap((f) => {
      let text: string;
      try { text = readFileSync(root + f, 'utf8'); } catch { return []; }
      return only.filter((lit) => text.includes(lit)).map((lit) => `${f}: ${lit}`);
    });
    expect(hits).toEqual([]);
  });
});

// Models come from OpenRouter only; the earlier local model server is mentioned nowhere but in the history.
describe('no third model source', () => {
  it('no tracked file names it outside specs/research, DECISIONS.md and its removal change', () => {
    const word = 'olla' + 'ma'; // in pieces, so this file needs no exemption
    const root = new URL('../../../', import.meta.url).pathname;
    const history = new RegExp(`^(specs/research/|DECISIONS\\.md$|specs/changes/remove-${word}/)`);
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !history.test(f));
    const hits = files.filter((f) => {
      try { return new RegExp(word, 'i').test(readFileSync(root + f, 'utf8')); } catch { return false; }
    });
    expect(hits).toEqual([]);
  });
});
