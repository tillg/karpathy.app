import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedHome } from '../src/home.js';

describe('seedHome: the shell dotfiles the image brings, copied into the home volume once', () => {
  it('copies what the home lacks and never overwrites what the user has', async () => {
    const skel = await mkdtemp(join(tmpdir(), 'skel-'));
    const home = await mkdtemp(join(tmpdir(), 'home-'));
    await writeFile(join(skel, '.zshrc'), 'image zshrc\n');
    await writeFile(join(skel, '.p10k.zsh'), 'image p10k\n');
    await writeFile(join(home, '.p10k.zsh'), 'my own p10k\n');

    expect(await seedHome(skel, home)).toEqual(['.zshrc']);
    expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe('image zshrc\n');
    expect(await readFile(join(home, '.p10k.zsh'), 'utf8')).toBe('my own p10k\n');

    await writeFile(join(home, '.zshrc'), 'edited\n');
    expect(await seedHome(skel, home)).toEqual([]);
    expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe('edited\n');
  });

  it('files in folders too (~/.claude/CLAUDE.md), next to what the folder already holds', async () => {
    const skel = await mkdtemp(join(tmpdir(), 'skel-'));
    const home = await mkdtemp(join(tmpdir(), 'home-'));
    await mkdir(join(skel, '.claude'));
    await writeFile(join(skel, '.claude', 'CLAUDE.md'), 'use vault commit\n');
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude', 'settings.json'), '{}');

    expect(await seedHome(skel, home)).toEqual(['.claude/CLAUDE.md']);
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('use vault commit\n');
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}');
    // A fresh home: the folder is made.
    const fresh = await mkdtemp(join(tmpdir(), 'home-'));
    expect(await seedHome(skel, fresh)).toEqual(['.claude/CLAUDE.md']);
  });

  it('no skeleton folder (an older image, the tests): nothing to do', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'));
    expect(await seedHome(join(home, 'missing'), home)).toEqual([]);
  });
});
