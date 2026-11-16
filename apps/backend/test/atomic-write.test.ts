import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeOpenPage } from '../src/open-page.js';
import { syncVisionModel } from '../src/vision-model.js';

// #175: the terminal can write the vaults dir's root, where the backend keeps state for opencode (.open-page,
// .vision.json, .browser-calls). Its writes must not follow a symlink planted there into backend-only files.
describe('state files in the vaults root', () => {
  async function setup() {
    const base = await mkdtemp(join(tmpdir(), 'kai-atomic-'));
    const vaults = join(base, 'vaults');
    const secret = join(base, 'config.json');
    await mkdir(vaults);
    await writeFile(secret, 'precious');
    return { vaults, secret };
  }

  it('a symlink at the old predictable temp name is not written through', async () => {
    const { vaults, secret } = await setup();
    await symlink(secret, join(vaults, `.vision.json.${process.pid}.tmp`));
    await syncVisionModel(vaults, { visionModel: 'gw/m2', defaultVisionModel: 'gw/m1', visionGateway: 'gw' });
    expect(await readFile(secret, 'utf8')).toBe('precious');
    expect(JSON.parse(await readFile(join(vaults, '.vision.json'), 'utf8'))).toEqual({ model: 'm2' });
  });

  it('a state folder replaced by a symlink is refused, not written into', async () => {
    const { vaults, secret } = await setup();
    await symlink(join(secret, '..'), join(vaults, '.open-page'));
    await expect(writeOpenPage(vaults, 'ses_1', { path: 'a.md', mode: 'read', unsaved: false })).rejects.toThrow(/symlink/);
    expect((await lstat(join(vaults, '.open-page'))).isSymbolicLink()).toBe(true);
  });
});
