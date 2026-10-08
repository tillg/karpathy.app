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
    ai: { model: 'ollama/qwen2.5:3b', web_access: true },
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
      defaultModel: 'ollama/qwen2.5:3b',
      webAccess: true,
      commitReminderThreshold: 4,
      visibleDotDirs: ['.agents'],
    });
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
