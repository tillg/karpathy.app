import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tidyAttachments } from '../src/tidy-attachments.js';
import { makeApp } from './app-helpers.js';
import { makeRemote } from './helpers.js';
import { testDir } from './opencode-container.js';

// Pictures go into the folder of the note that shows them (`dir/stem/stem.md` + the picture). Cases are shapes
// found in real vaults: ingests that dropped pictures flat into `Wiki/` next to many notes.

const vault = testDir('tidy-attachments');
const exists = (p: string) => stat(join(vault, p)).then(() => true, () => false);
const read = (p: string) => readFile(join(vault, p), 'utf8');

async function put(files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(vault, p)), { recursive: true });
    await writeFile(join(vault, p), text);
  }
}

beforeEach(async () => {
  await rm(vault, { recursive: true, force: true });
  await mkdir(vault, { recursive: true });
});

describe('tidyAttachments', () => {
  it('moves a flat note and its pictures into the note\'s own folder, rewriting path-form links', async () => {
    await put({
      'Wiki/apfel-chutney.md': '# Chutney\n![[Wiki/apfel-chutney-glas.jpg]]\n![[Wiki/apfel-chutney-topdown.jpg|300]]\n',
      'Wiki/apfel-chutney-glas.jpg': 'jpg1',
      'Wiki/apfel-chutney-topdown.jpg': 'jpg2',
      'Wiki/rezepte.md': 'See [[Wiki/apfel-chutney|Chutney]] and [[apfel-chutney]].\n',
    });
    const r = await tidyAttachments(vault);
    expect(r.moved).toEqual([
      { from: 'Wiki/apfel-chutney.md', to: 'Wiki/apfel-chutney/apfel-chutney.md' },
      { from: 'Wiki/apfel-chutney-glas.jpg', to: 'Wiki/apfel-chutney/apfel-chutney-glas.jpg' },
      { from: 'Wiki/apfel-chutney-topdown.jpg', to: 'Wiki/apfel-chutney/apfel-chutney-topdown.jpg' },
    ]);
    expect(await exists('Wiki/apfel-chutney.md')).toBe(false);
    expect(await read('Wiki/apfel-chutney/apfel-chutney-glas.jpg')).toBe('jpg1');
    expect(await read('Wiki/apfel-chutney/apfel-chutney.md')).toBe(
      '# Chutney\n![[Wiki/apfel-chutney/apfel-chutney-glas.jpg]]\n![[Wiki/apfel-chutney/apfel-chutney-topdown.jpg|300]]\n');
    expect(await read('Wiki/rezepte.md')).toBe('See [[Wiki/apfel-chutney/apfel-chutney|Chutney]] and [[apfel-chutney]].\n');
    expect(r.rewritten.sort()).toEqual(['Wiki/apfel-chutney/apfel-chutney.md', 'Wiki/rezepte.md']);
  });

  it('gives a picture two notes show to the one whose name it starts with; bare embeds stay as they are', async () => {
    await put({
      'Wiki/wamsler-oefen-uebersicht.md': '![[wamsler-k148-f-weiss.jpg]]\n![[wamsler-m80.jpg]]\n',
      'Wiki/wamsler-k148-f.md': '![[wamsler-k148-f-weiss.jpg]]\n',
      'Wiki/wamsler-k148-f-weiss.jpg': 'a',
      'Wiki/wamsler-m80.jpg': 'b',
    });
    await tidyAttachments(vault);
    expect(await exists('Wiki/wamsler-k148-f/wamsler-k148-f-weiss.jpg')).toBe(true);
    expect(await exists('Wiki/wamsler-oefen-uebersicht/wamsler-m80.jpg')).toBe(true);
    expect(await read('Wiki/wamsler-k148-f/wamsler-k148-f.md')).toBe('![[wamsler-k148-f-weiss.jpg]]\n');
    expect(await read('Wiki/wamsler-oefen-uebersicht/wamsler-oefen-uebersicht.md')).toBe('![[wamsler-k148-f-weiss.jpg]]\n![[wamsler-m80.jpg]]\n');
  });

  it('moves a picture into a note that already has its own folder and rewrites relative Markdown links', async () => {
    await put({
      'Wiki/ofen/ofen.md': '![Ofen](../ofen%20bild.png "t")\n',
      'Wiki/ofen bild.png': 'p',
      'Wiki/other.md': '![x](ofen%20bild.png)\n',
    });
    const r = await tidyAttachments(vault);
    expect(r.moved).toEqual([{ from: 'Wiki/ofen bild.png', to: 'Wiki/ofen/ofen bild.png' }]);
    expect(await read('Wiki/ofen/ofen.md')).toBe('![Ofen](ofen%20bild.png "t")\n');
    expect(await read('Wiki/other.md')).toBe('![x](ofen/ofen%20bild.png)\n');
  });

  it('moves the note\'s own relative links one level deeper', async () => {
    await put({
      'Wiki/note.md': '![p](pic.png) and [other](other.md)\n',
      'Wiki/pic.png': 'p',
      'Wiki/other.md': 'x\n',
    });
    await tidyAttachments(vault);
    expect(await read('Wiki/note/note.md')).toBe('![p](pic.png) and [other](../other.md)\n');
  });

  it('leaves pictures that already sit with a note showing them, unreferenced pictures and pictures in code', async () => {
    const files = {
      'Wiki/filme/anna/anna.md': '![[poster.jpg]]\n',
      'Wiki/filme/anna/poster.jpg': 'p',
      'Sources/mail-1/index.md': '![[scan.png]]\n',
      'Sources/mail-1/scan.png': 's',
      'Wiki/orphan.png': 'o',
      'Wiki/code.md': '`![[Wiki/in-code.png]]`\n```\n![[Wiki/in-code.png]]\n```\n',
      'Wiki/in-code.png': 'c',
    };
    await put(files);
    const r = await tidyAttachments(vault);
    expect(r.moved).toEqual([]);
    for (const [p, text] of Object.entries(files)) expect(await read(p)).toBe(text);
  });

  it('never moves a picture out of Sources/: a source keeps its media, pages show them from there', async () => {
    const files = {
      'Sources/mail-2/index.md': 'mail\n',
      'Sources/mail-2/photo.jpg': 'p',
      'Sources/media/shared.jpg': 's',
      'Wiki/keller.md': '![[photo.jpg]]\n![[Sources/media/shared.jpg]]\n',
    };
    await put(files);
    expect((await tidyAttachments(vault)).moved).toEqual([]);
    for (const [p, text] of Object.entries(files)) expect(await read(p)).toBe(text);
  });

  it('skips a picture whose target name is taken and keeps everything else of that note', async () => {
    await put({
      'Wiki/note.md': '![[Wiki/a.png]]\n![[Wiki/b.png]]\n',
      'Wiki/a.png': 'new',
      'Wiki/b.png': 'b',
      'Wiki/note/a.png': 'old',
    });
    const r = await tidyAttachments(vault);
    expect(r.skipped).toEqual([{ path: 'Wiki/a.png', reason: 'Wiki/note/a.png already exists' }]);
    expect(await read('Wiki/note/note.md')).toBe('![[Wiki/a.png]]\n![[Wiki/note/b.png]]\n');
    expect(await read('Wiki/note/a.png')).toBe('old');
  });

  it('skips a note that cannot move into its own folder', async () => {
    await put({ 'Wiki/note.md': '![[Wiki/a.png]]\n', 'Wiki/a.png': 'a', 'Wiki/note': 'a file' });
    const r = await tidyAttachments(vault);
    expect(r.moved).toEqual([]);
    expect(r.skipped).toEqual([{ path: 'Wiki/a.png', reason: 'Wiki/note is a file, so Wiki/note.md can\'t move into its own folder' }]);
  });

  it('only looks at pictures the given notes show', async () => {
    await put({ 'Wiki/a.md': '![[Wiki/a.png]]\n', 'Wiki/a.png': 'a', 'Wiki/b.md': '![[Wiki/b.png]]\n', 'Wiki/b.png': 'b' });
    const r = await tidyAttachments(vault, { notes: ['Wiki/b.md'] });
    expect(r.moved.map((m) => m.from)).toEqual(['Wiki/b.md', 'Wiki/b.png']);
    expect(await exists('Wiki/a.md')).toBe(true);
  });

  it('changes nothing on a dry run', async () => {
    await put({ 'Wiki/a.md': '![[Wiki/a.png]]\n', 'Wiki/a.png': 'a' });
    const r = await tidyAttachments(vault, { dryRun: true });
    expect(r.moved).toHaveLength(2);
    expect(await read('Wiki/a.md')).toBe('![[Wiki/a.png]]\n');
    expect(await exists('Wiki/a/a.md')).toBe(false);
  });
});

describe('Vaults.tidyAttachments (after an AI turn)', () => {
  it('moves the pictures of the pages the AI wrote and carries their AI-touched marks along', async () => {
    const remote = await makeRemote({ 'Wiki/kuchen.md': 'x\n', 'Wiki/kuchen-foto.jpg': 'jpg', 'Wiki/other.md': '![[Wiki/other.png]]\n', 'Wiki/other.png': 'o' });
    const t = await makeApp(remote.remoteBase);
    const id = await t.addVault(remote.repo);
    const root = t.vaults.vaultRootDir(id);
    await writeFile(join(root, 'Wiki/kuchen.md'), '![[Wiki/kuchen-foto.jpg]]\n');
    await t.vaults.markAiTouched(id, ['Wiki/kuchen.md']);
    const r = await t.vaults.tidyAttachments(id, ['Wiki/kuchen.md']);
    expect(r.moved.map((m) => m.to)).toEqual(['Wiki/kuchen/kuchen.md', 'Wiki/kuchen/kuchen-foto.jpg']);
    expect(await readFile(join(root, 'Wiki/kuchen/kuchen.md'), 'utf8')).toBe('![[Wiki/kuchen/kuchen-foto.jpg]]\n');
    expect(t.vaults.aiTouched(id).sort()).toEqual(['Wiki/kuchen-foto.jpg', 'Wiki/kuchen.md', 'Wiki/kuchen/kuchen-foto.jpg', 'Wiki/kuchen/kuchen.md']);
    // Pages the AI didn't write stay as they are.
    expect(await readFile(join(root, 'Wiki/other.md'), 'utf8')).toBe('![[Wiki/other.png]]\n');
  });
});
