import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBackendSettings } from '../src/settings.js';

async function rendered(edit: (s: Record<string, unknown>) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  await writeFile(join(dir, 'bearer_token'), 'tok\n');
  await writeFile(join(dir, 'opencode_password'), 'pw');
  await writeFile(join(dir, 'github_token'), '');
  const s: Record<string, unknown> = {
    auth: { bearer_token: { file: join(dir, 'bearer_token') }, opencode_password: { file: join(dir, 'opencode_password') } },
    git: { remote_base: 'file:///remotes/', author: { name: 'Dev User', email: 'dev@example.com' }, github_token: { file: join(dir, 'github_token') } },
    ai: { model: 'openrouter/qwen2.5:3b', web_access: true },
    commit_reminder_threshold: 4,
    files: { visible_dot_dirs: ['.agents'] },
  };
  edit(s);
  await writeFile(join(dir, 'settings.json'), JSON.stringify(s));
  return join(dir, 'settings.json');
}

describe('loadBackendSettings', () => {
  it('loads settings.json and its secret files', async () => {
    expect(loadBackendSettings(await rendered())).toEqual({
      token: 'tok',
      opencodePassword: 'pw',
      githubToken: undefined,
      remoteBase: 'file:///remotes/',
      identity: { name: 'Dev User', email: 'dev@example.com' },
      defaultModel: 'openrouter/qwen2.5:3b',
      defaultTitleModel: '',
      defaultVisionModel: '',
      visionGateway: '',
      webAccess: true,
      commitReminderThreshold: 4,
      visibleDotDirs: ['.agents'],
      secrets: [],
      workerToken: undefined,
    });
  });

  it('reads title_model, vision_model and vision_gateway; an older settings.json falls back', async () => {
    const f = await rendered((s) => (s.ai = { model: 'gw/a', title_model: 'gw/t', vision_model: 'vl-2b', vision_gateway: 'gw', web_access: true }));
    expect(loadBackendSettings(f)).toMatchObject({ defaultModel: 'gw/a', defaultTitleModel: 'gw/t', defaultVisionModel: 'gw/vl-2b', visionGateway: 'gw' });
    expect(loadBackendSettings(await rendered())).toMatchObject({ defaultTitleModel: '', defaultVisionModel: '', visionGateway: '' });
  });

  it('settings.json without `secrets` loads as [], one with the manifest passes it on', async () => {
    expect(loadBackendSettings(await rendered()).secrets).toEqual([]);
    const entry = { name: 'exa_api_key', component: 'opencode', purpose: 'Web search (Exa)', optional: true, set: false };
    expect(loadBackendSettings(await rendered((s) => (s.secrets = [entry]))).secrets).toEqual([entry]);
    const bad = await rendered((s) => (s.secrets = [{ ...entry, value: 'x' }]));
    expect(() => loadBackendSettings(bad)).toThrow(/secrets/);
  });

  it('ingest.worker_token is read from its file, absent is fine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-'));
    await writeFile(join(dir, 'ingest_worker_token'), 'wt\n');
    expect(loadBackendSettings(await rendered((s) => (s.ingest = { worker_token: { file: join(dir, 'ingest_worker_token') } }))).workerToken).toBe('wt');
    // No ingest block (an older settings.json), an empty file or none at all (a stack without the secret): no worker token.
    expect(loadBackendSettings(await rendered()).workerToken).toBeUndefined();
    await writeFile(join(dir, 'empty'), '');
    expect(loadBackendSettings(await rendered((s) => (s.ingest = { worker_token: { file: join(dir, 'empty') } }))).workerToken).toBeUndefined();
    expect(loadBackendSettings(await rendered((s) => (s.ingest = { worker_token: { file: join(dir, 'missing') } }))).workerToken).toBeUndefined();
  });

  it('a missing or invalid file names the path', async () => {
    expect(() => loadBackendSettings('/nope/settings.json')).toThrow(/\/nope\/settings\.json/);
    const bad = await rendered((s) => delete s.ai);
    expect(() => loadBackendSettings(bad)).toThrow(new RegExp(`${bad}.*ai`));
  });

  it('rejects .git and names without a leading dot in visible_dot_dirs', async () => {
    await expect(rendered((s) => (s.files = { visible_dot_dirs: ['.git'] }))).resolves.toSatisfy((f: string) => {
      expect(() => loadBackendSettings(f)).toThrow(/visible_dot_dirs/);
      return true;
    });
    const f = await rendered((s) => (s.files = { visible_dot_dirs: ['agents'] }));
    expect(() => loadBackendSettings(f)).toThrow(/visible_dot_dirs/);
  });
});
