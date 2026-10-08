import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { moveToSources } from '../../../deploy/opencode/lib/move-to-sources.js';
import { testDir } from './opencode-container.js';

// The move_to_sources tool's move, on a real directory (the tool itself runs inside opencode: opencode-tools.test.ts).

const base = testDir('move-to-sources');
const vault = join(base, 'vault');
const exists = (p: string) => stat(join(vault, p)).then(() => true, () => false);

async function item(name: string, frontmatter = 'title: x') {
  await mkdir(join(vault, 'Input', name), { recursive: true });
  await writeFile(join(vault, 'Input', name, 'index.md'), `---\n${frontmatter}\n---\n# ${name}\n`);
}

beforeEach(async () => {
  await rm(base, { recursive: true, force: true });
  await mkdir(join(vault, 'Input'), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
});

describe('moveToSources', () => {
  it('moves an item with its media to Sources/, creating Sources/ if missing', async () => {
    await item('mail-2026-10-08-a');
    await writeFile(join(vault, 'Input/mail-2026-10-08-a/photo.jpg'), 'jpg');
    const r = await moveToSources(vault, 'mail-2026-10-08-a');
    expect(r.output).toBe('Moved to Sources/mail-2026-10-08-a');
    expect(r.files.sort((a, b) => a.filePath.localeCompare(b.filePath))).toEqual([
      { filePath: 'Input/mail-2026-10-08-a/index.md', movePath: 'Sources/mail-2026-10-08-a/index.md' },
      { filePath: 'Input/mail-2026-10-08-a/photo.jpg', movePath: 'Sources/mail-2026-10-08-a/photo.jpg' },
    ]);
    expect(await exists('Input/mail-2026-10-08-a')).toBe(false);
    expect(await readFile(join(vault, 'Sources/mail-2026-10-08-a/photo.jpg'), 'utf8')).toBe('jpg');
    expect(await readFile(join(vault, 'Sources/mail-2026-10-08-a/index.md'), 'utf8')).toContain('# mail-2026-10-08-a');
  });

  it('moves an item whose links are all resolved or failed', async () => {
    await item('web-a', 'unresolved_links: []\nresolved_links:\n  - url: https://x.example\n    source: web-b');
    await moveToSources(vault, 'web-a');
    expect(await exists('Sources/web-a/index.md')).toBe(true);
  });

  it('never overwrites an existing Sources/<name>, not even an empty folder', async () => {
    await item('dup');
    await mkdir(join(vault, 'Sources/dup'), { recursive: true });
    await expect(moveToSources(vault, 'dup')).rejects.toThrow('Sources/dup exists: rename or merge by hand');
    expect(await exists('Input/dup/index.md')).toBe(true);
  });

  it('refuses names that are not a single visible path segment', async () => {
    await item('x');
    for (const name of ['../x', 'a/b', '.x', '', '..', 'x\\y'])
      await expect(moveToSources(vault, name)).rejects.toThrow('not an input item name');
  });

  it('refuses a missing item and a loose file', async () => {
    await expect(moveToSources(vault, 'nope')).rejects.toThrow('no input item Input/nope');
    await writeFile(join(vault, 'Input/loose.md'), 'x');
    await expect(moveToSources(vault, 'loose.md')).rejects.toThrow('no input item Input/loose.md');
  });

  it('refuses a symlinked item and a symlinked Sources/ or Input/', async () => {
    await symlink(join(base, 'other'), join(vault, 'Input/linked'));
    await expect(moveToSources(vault, 'linked')).rejects.toThrow('symlink');

    await item('y');
    await symlink(join(base, 'other'), join(vault, 'Sources'));
    await expect(moveToSources(vault, 'y')).rejects.toThrow('symlink');
    expect(await exists('Input/y/index.md')).toBe(true);

    await rm(join(vault, 'Sources'));
    await rm(join(vault, 'Input'), { recursive: true });
    await mkdir(join(base, 'other/z'), { recursive: true });
    await symlink(join(base, 'other'), join(vault, 'Input'));
    await expect(moveToSources(vault, 'z')).rejects.toThrow('symlink');
  });

  it('refuses an item that still has unresolved_links', async () => {
    await item('insta-a', 'title: x\nunresolved_links:\n  - https://www.instagram.com/p/abc/');
    await expect(moveToSources(vault, 'insta-a')).rejects.toThrow('Input/insta-a is still being processed');
    await item('insta-b', "unresolved_links: ['https://www.instagram.com/p/abc/']");
    await expect(moveToSources(vault, 'insta-b')).rejects.toThrow('still being processed');
    // A blank line or a comment between the key and its list, a quoted key.
    await item('insta-c', 'unresolved_links:\n\n  # pending\n  - url: https://www.instagram.com/p/c/');
    await expect(moveToSources(vault, 'insta-c')).rejects.toThrow('still being processed');
    await item('insta-d', '"unresolved_links":\n  - url: https://www.instagram.com/p/d/');
    await expect(moveToSources(vault, 'insta-d')).rejects.toThrow('still being processed');
    expect(await exists('Input/insta-a/index.md')).toBe(true);
  });
});
