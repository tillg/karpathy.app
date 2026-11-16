import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git, registerGitDirs, repoEnv, runGit } from '../src/git.js';
import { identity, makeRemote, sh } from './helpers.js';

describe('runGit timeout', () => {
  it('a hung git ends on SIGTERM (so it can drop its lock files), well before the SIGKILL grace runs out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kai-git-'));
    const t0 = Date.now();
    // stdin stays open: hash-object waits for input forever.
    const r = await runGit(dir, ['hash-object', '--stdin'], { identity, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

/**
 * The terminal (#175) writes the working trees but mounts the git dirs read-only: a vault's git dir lives outside its
 * clone (`<gitdirs>/<id>`), and the backend's git always gets it explicitly (repoEnv). Whatever `.git` the terminal
 * plants in a working tree is ignored, and a repo nested in a vault is never entered.
 */
describe('runGit in a working tree the terminal can write', () => {
  /** A clone whose git dir lives outside it, as the backend makes it; repoEnv knows the two dirs. */
  async function clone() {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const base = await mkdtemp(join(tmpdir(), 'kai-git-'));
    const vaults = join(base, 'vaults');
    const gitdirs = join(base, 'gitdirs');
    await mkdir(vaults);
    await mkdir(gitdirs);
    registerGitDirs(vaults, gitdirs);
    sh(vaults, 'clone', '-q', `--separate-git-dir=${join(gitdirs, 'v')}`, remote.bare, 'v');
    return { c: join(vaults, 'v'), gitdir: join(gitdirs, 'v'), marker: join(base, 'pwned'), base };
  }
  /** A git dir with a config that runs `touch marker` through a filter, fsmonitor and textconv. */
  async function evilGitDir(dir: string, marker: string) {
    sh(dirname(dir), 'init', '-q', dir);
    await appendFile(join(dir, '.git', 'config'), `[filter "x"]\n\tclean = touch ${marker}\n[core]\n\tfsmonitor = touch ${marker}\n[diff "x"]\n\ttextconv = touch ${marker}\n`);
    return join(dir, '.git');
  }

  it('repoEnv points git at the git dir outside the clone, from any folder of it', async () => {
    const { c, gitdir } = await clone();
    expect(repoEnv(c)).toMatchObject({ GIT_DIR: gitdir, GIT_WORK_TREE: c });
    await mkdir(join(c, 'sub'));
    expect(repoEnv(join(c, 'sub'))).toMatchObject({ GIT_DIR: gitdir, GIT_WORK_TREE: c });
    expect(repoEnv(tmpdir()).GIT_DIR).toBeUndefined();
  });

  it('a .git file the terminal points at a hostile git dir is ignored', async () => {
    const { c, marker, base } = await clone();
    const evil = await evilGitDir(join(base, 'evil'), marker);
    await writeFile(join(c, '.git'), `gitdir: ${evil}\n`);
    await writeFile(join(c, '.gitattributes'), '* filter=x diff=x\n');
    await writeFile(join(c, 'a.md'), 'changed\n');
    const git = new Git(c, { identity });
    expect((await git.run(['status', '--porcelain'])).stdout).toContain('a.md');
    await git.run(['add', '-A']);
    await git.run(['diff', '--cached']);
    await git.run(['commit', '-qm', 'x']);
    expect(existsSync(marker)).toBe(false);
  });

  it('a .git folder planted in a sub-folder (a vault root) is ignored', async () => {
    const { c, gitdir, marker } = await clone();
    await mkdir(join(c, 'sub'));
    await evilGitDir(join(c, 'sub'), marker);
    await writeFile(join(c, 'sub', 'n.md'), 'n\n');
    const r = await runGit(join(c, 'sub'), ['rev-parse', '--absolute-git-dir'], { identity });
    expect(r.stdout.trim()).toBe(realpathSync(gitdir));
    expect(existsSync(marker)).toBe(false);
  });

  it('a repo nested in the working tree is never entered (its config can run nothing)', async () => {
    const { c, marker } = await clone();
    const nested = join(c, 'nested');
    await mkdir(nested);
    sh(nested, 'init', '-q');
    await writeFile(join(nested, 'f.md'), 'f\n');
    sh(nested, 'add', '-A');
    sh(nested, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'n');
    await appendFile(join(nested, '.git', 'config'), `[filter "x"]\n\tclean = touch ${marker}\n[core]\n\tfsmonitor = touch ${marker}\n`);
    await writeFile(join(nested, '.gitattributes'), '* filter=x\n');
    const git = new Git(c, { identity });
    await git.run(['add', '-A']);
    await git.run(['commit', '-qm', 'with nested']);
    await writeFile(join(nested, 'f.md'), 'changed\n');
    await git.run(['status', '--porcelain']);
    await git.run(['diff', 'HEAD']);
    expect(existsSync(marker)).toBe(false);
  });

  it('a planted hook does not run', async () => {
    const { c, gitdir, marker } = await clone();
    // Hooks live in the git dir, which the terminal can't write; this guards the backend's own env as well.
    await writeFile(join(gitdir, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(join(c, 'b.md'), 'b\n');
    const git = new Git(c, { identity });
    await git.run(['add', 'b.md']);
    await git.run(['commit', '-m', 'b']);
    expect(existsSync(marker)).toBe(false);
  });
});
