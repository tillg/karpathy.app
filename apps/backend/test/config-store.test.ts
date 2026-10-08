import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config-store.js';

const dir = () => mkdtemp(join(tmpdir(), 'cfg-'));

describe('ConfigStore', () => {
  it('starts with default settings (threshold 4, no model without the deployment default, web access on)', async () => {
    const s = await ConfigStore.open(await dir());
    expect(s.get().settings).toEqual({ commitReminderThreshold: 4, model: '', webAccess: true });
    expect(s.get().vaults).toEqual([]);
  });

  it('webAccess defaults to true, also for an old config without the key', async () => {
    const d = await dir();
    await writeFile(join(d, 'config.json'), JSON.stringify({ vaults: [], settings: { commitReminderThreshold: 9, model: 'a/b' } }));
    expect((await ConfigStore.open(d)).get().settings).toEqual({ commitReminderThreshold: 9, model: 'a/b', webAccess: true });
  });

  it('persists vault CRUD across reopen', async () => {
    const d = await dir();
    const s = await ConfigStore.open(d);
    await s.update((c) => c.vaults.push({ id: 'v1', name: 'V', repo: 'o/r', branch: 'main', root: '', cloned: false }));
    await s.update((c) => { c.vaults[0]!.name = 'Renamed'; });
    let r = await ConfigStore.open(d);
    expect(r.get().vaults.map((v) => v.name)).toEqual(['Renamed']);
    await r.update((c) => { c.vaults = []; });
    r = await ConfigStore.open(d);
    expect(r.get().vaults).toEqual([]);
  });

  it('a leftover temp file from a killed write does not corrupt the store', async () => {
    const d = await dir();
    const s = await ConfigStore.open(d);
    await s.update((c) => { c.settings.commitReminderThreshold = 7; });
    // Simulate a crash mid-write: a half-written temp file next to the real one.
    await writeFile(join(d, 'config.json.999.tmp'), '{"vaults": [');
    const r = await ConfigStore.open(d);
    expect(r.get().settings.commitReminderThreshold).toBe(7);
    expect(JSON.parse(await readFile(join(d, 'config.json'), 'utf8')).settings.commitReminderThreshold).toBe(7);
  });

  it('env defaults apply below stored settings', async () => {
    const d = await dir();
    const s = await ConfigStore.open(d, { model: 'openai/gpt-5-mini' });
    expect(s.get().settings.model).toBe('openai/gpt-5-mini');
    await s.update((c) => { c.settings.model = 'x/y'; });
    expect((await ConfigStore.open(d, { model: 'openai/gpt-5-mini' })).get().settings.model).toBe('x/y');
  });

  it('model override only while it differs from the default', async () => {
    const d = await dir();
    const raw = async () => JSON.parse(await readFile(join(d, 'config.json'), 'utf8')).settings;
    // (a) no file: the default, nothing persisted as an override
    const a = await ConfigStore.open(d, { model: 'd/1' });
    expect(a.get().settings.model).toBe('d/1');
    await a.update((c) => { c.settings.commitReminderThreshold = 5; });
    expect(await raw()).not.toHaveProperty('modelOverride');
    expect(await raw()).not.toHaveProperty('model');
    // (b) an override survives a new default
    await a.update((c) => { c.settings.model = 'm/2'; });
    expect((await raw()).modelOverride).toBe('m/2');
    const b = await ConfigStore.open(d, { model: 'd/3' });
    expect(b.get().settings.model).toBe('m/2');
    expect(b.defaultModel).toBe('d/3');
    // (c) picking the default removes the override
    await b.update((c) => { c.settings.model = 'd/3'; });
    expect(await raw()).not.toHaveProperty('modelOverride');
    // (d) so the next default applies
    expect((await ConfigStore.open(d, { model: 'd/4' })).get().settings.model).toBe('d/4');
  });

  it('a legacy persisted model becomes an override only if it differs from the default', async () => {
    const d = await dir();
    await writeFile(join(d, 'config.json'), JSON.stringify({ vaults: [], settings: { commitReminderThreshold: 4, model: 'd/1', webAccess: true } }));
    expect((await ConfigStore.open(d, { model: 'd/1' })).get().settings.model).toBe('d/1');
    // differs from the new default: it was the Admin's choice, kept as an override
    expect((await ConfigStore.open(d, { model: 'd/9' })).get().settings.model).toBe('d/1');
    await writeFile(join(d, 'config.json'), JSON.stringify({ vaults: [], settings: { commitReminderThreshold: 4, model: 'm/2', webAccess: true } }));
    const s = await ConfigStore.open(d, { model: 'd/1' });
    expect(s.get().settings.model).toBe('m/2');
    await s.update((c) => { c.settings.webAccess = false; });
    expect(JSON.parse(await readFile(join(d, 'config.json'), 'utf8')).settings).toEqual({ commitReminderThreshold: 4, webAccess: false, modelOverride: 'm/2' });
  });

  it('one failed write does not poison later updates', async () => {
    const { chmod } = await import('node:fs/promises');
    const d = await dir();
    const s = await ConfigStore.open(d);
    await s.update((c) => { c.settings.commitReminderThreshold = 5; });
    await chmod(d, 0o500); // temp file can't be created
    await expect(s.update((c) => { c.settings.commitReminderThreshold = 6; })).rejects.toThrow();
    await chmod(d, 0o700);
    await s.update((c) => { c.settings.commitReminderThreshold = 7; });
    expect((await ConfigStore.open(d)).get().settings.commitReminderThreshold).toBe(7);
  });

  it('githubToken round-trips and is not part of settings', async () => {
    const d = await dir();
    const s = await ConfigStore.open(d);
    await s.update((c) => { c.githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz'; });
    const r = await ConfigStore.open(d);
    expect(r.get().githubToken).toBe('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(r.get().settings).not.toHaveProperty('githubToken');
  });
});
