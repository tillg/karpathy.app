import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git, runGit, UnsafeGitConfigError } from '../src/git.js';
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
 * The terminal (#175) can write `.git` in a clone; the backend runs git there with the GitHub token in its env. So
 * hooks never run, and a clone whose local config could run a command is refused before git starts.
 */
describe('runGit in a clone the terminal can write', () => {
  async function clone(extraConfig = '') {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const dir = await mkdtemp(join(tmpdir(), 'kai-git-'));
    sh(dir, 'clone', '-q', remote.bare, 'c');
    const c = join(dir, 'c');
    if (extraConfig) await appendFile(join(c, '.git', 'config'), extraConfig);
    return { c, marker: join(dir, 'pwned') };
  }

  it('a planted hook does not run', async () => {
    const { c, marker } = await clone();
    await writeFile(join(c, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(join(c, 'b.md'), 'b\n');
    const git = new Git(c, { identity });
    await git.run(['add', 'b.md']);
    await git.run(['commit', '-m', 'b']);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['filter.x.clean', '[filter "x"]\n\tclean = touch MARKER\n'],
    ['core.fsmonitor', '[core]\n\tfsmonitor = touch MARKER\n'],
    ['diff.x.textconv', '[diff "x"]\n\ttextconv = touch MARKER\n'],
    ['include.path', '[include]\n\tpath = /tmp/other\n'],
    ['extensions.worktreeconfig', '[extensions]\n\tworktreeConfig = true\n'],
    ['credential.helper', '[credential]\n\thelper = !touch MARKER\n'],
    ['core.sshcommand', '[core]\n\tsshCommand = touch MARKER\n'],
  ])('refuses a clone whose .git/config sets %s, before git runs', async (key, cfg) => {
    const { c, marker } = await clone();
    await appendFile(join(c, '.git', 'config'), cfg.replace('MARKER', marker));
    await writeFile(join(c, '.gitattributes'), '* filter=x diff=x\n');
    await writeFile(join(c, 'a.md'), 'changed\n');
    const err = await runGit(c, ['status', '--porcelain'], { identity }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsafeGitConfigError);
    expect(err.message).toContain(key);
    // From a sub-folder of the clone (a vault root) too.
    await mkdir(join(c, 'sub'), { recursive: true });
    expect(await runGit(join(c, 'sub'), ['status'], { identity }).catch((e) => e)).toBeInstanceOf(UnsafeGitConfigError);
    expect(existsSync(marker)).toBe(false);
  });

  it('a plain clone with the usual keys runs', async () => {
    const { c } = await clone('[user]\n\tname = Me\n\temail = me@example.com\n[pull]\n\trebase = false\n[branch "x"]\n\tremote = origin\n\tmerge = refs/heads/x\n');
    expect((await runGit(c, ['status', '--porcelain'], { identity })).code).toBe(0);
  });

  it('refuses a .git that is a file pointing elsewhere', async () => {
    const { c } = await clone();
    await rename(join(c, '.git'), join(c, '..', 'elsewhere.git'));
    await writeFile(join(c, '.git'), `gitdir: ${join(c, '..', 'elsewhere.git')}\n`);
    expect(await runGit(c, ['status'], { identity }).catch((e) => e)).toBeInstanceOf(UnsafeGitConfigError);
  });
});
