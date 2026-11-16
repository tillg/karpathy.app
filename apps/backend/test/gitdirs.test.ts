import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp } from './app-helpers.js';
import { makeRemote, sh } from './helpers.js';

// #175: each vault's git dir lives in the git dirs volume (`<gitdirs>/<id>`), which the terminal mounts read-only;
// the working tree has a `.git` file pointing there. Clones made before move there at startup.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function dirs() {
  const base = await mkdtemp(join(tmpdir(), 'kai-gd-'));
  const d = { config: join(base, 'config'), vaults: join(base, 'vaults'), gitdirs: join(base, 'gitdirs') };
  await mkdir(d.vaults, { recursive: true });
  return d;
}

describe('git dirs outside the working trees', () => {
  it('a new clone keeps its git dir in the git dirs volume; the tree has a .git file', async () => {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const d = await dirs();
    const t = await makeApp(remote.remoteBase, { dirs: d, env: { gitDirsDir: d.gitdirs } });
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo);
    expect((await lstat(join(d.vaults, id, '.git'))).isFile()).toBe(true);
    expect(await readFile(join(d.vaults, id, '.git'), 'utf8')).toBe(`gitdir: ${realpathSync(join(d.gitdirs, id))}\n`);
    expect(existsSync(join(d.gitdirs, id, 'HEAD'))).toBe(true);
    // The app works on it as before.
    await writeFile(join(d.vaults, id, 'b.md'), 'b\n');
    expect((await t.api.post(`/vaults/${id}/commit`, { message: 'b' })).status).toBe(200);
    expect(remote.remoteLog()[0]).toBe('b');
    // Removing the vault removes its git dir too.
    expect((await t.api.delete(`/vaults/${id}`)).status).toBe(204);
    expect(existsSync(join(d.gitdirs, id))).toBe(false);
  });

  it('a clone from before moves its .git out at startup, keeping unpushed commits and uncommitted changes; again is a no-op', async () => {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const d = await dirs();
    // Before: no git dirs volume.
    const old = await makeApp(remote.remoteBase, { dirs: d, env: { gitDirsDir: undefined } });
    const id = await old.addVault(remote.repo);
    await old.vaults.close();
    const clone = join(d.vaults, id);
    expect((await lstat(join(clone, '.git'))).isDirectory()).toBe(true);
    await writeFile(join(clone, 'unpushed.md'), 'u\n');
    sh(clone, 'add', 'unpushed.md');
    sh(clone, 'commit', '-qm', 'unpushed');
    await writeFile(join(clone, 'a.md'), 'edited\n');

    for (let i = 0; i < 2; i++) {
      const t = await makeApp(remote.remoteBase, { dirs: d, env: { gitDirsDir: d.gitdirs } });
      expect((await lstat(join(clone, '.git'))).isFile()).toBe(true);
      expect(existsSync(join(clone, '.git.old'))).toBe(false);
      const st = (await t.api.get(`/vaults/${id}/status`)).body;
      expect(st).toMatchObject({ state: 'ready', unpushedCount: 1, changedCount: 1 });
      await t.vaults.close();
    }
  });

  it('a migration cut short (git dir copied, .git still a folder) completes', async () => {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const d = await dirs();
    const old = await makeApp(remote.remoteBase, { dirs: d, env: { gitDirsDir: undefined } });
    const id = await old.addVault(remote.repo);
    await old.vaults.close();
    // A crash left a half-copied tmp dir behind.
    await mkdir(join(d.gitdirs, `${id}.tmp`, 'objects'), { recursive: true });
    const t = await makeApp(remote.remoteBase, { dirs: d, env: { gitDirsDir: d.gitdirs } });
    cleanups.push(() => t.vaults.close());
    expect(existsSync(join(d.gitdirs, `${id}.tmp`))).toBe(false);
    expect((await t.api.get(`/vaults/${id}/status`)).body.state).toBe('ready');
  });
});
