import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { linkedFiles, MEDIA, relinkFile, rewriteLinks } from '@karpathy/shared';
import { listTree, versionOf, versionOfFile } from './files.js';
import { attachmentFolder } from './vaults.js';

export interface TidyResult {
  /** Files moved, in order: a note into its own folder, then its pictures. */
  moved: { from: string; to: string }[];
  /** Pages whose links were rewritten (final paths). */
  rewritten: string[];
  /** Pictures left where they are, and why. */
  skipped: { path: string; reason: string }[];
}

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const isImage = (p: string) => MEDIA[p.slice(p.lastIndexOf('.') + 1).toLowerCase()]?.kind === 'image';
const isPage = (p: string) => /\.md$/i.test(p);
/** A source keeps its media (`Sources/<source>/…`); pages show them from there. */
const inSources = (p: string) => p.split('/')[0]!.toLowerCase() === 'sources';

/** The folder a note owns, or null when the note isn't in one (`dir/stem/stem.md` or `dir/index.md`). */
const ownFolder = (note: string) => (attachmentFolder(note).move ? null : dirOf(note));
const inFolder = (path: string, folder: string) => dirOf(path) === folder || (folder !== '' && path.startsWith(`${folder}/`));

/** Of the notes showing a picture, the one whose name the picture's name starts with most; then A–Z. */
function owner(image: string, notes: string[]): string {
  const name = base(image).toLowerCase();
  const shared = (note: string) => {
    const stem = base(note).replace(/\.md$/i, '').toLowerCase();
    let i = 0;
    while (i < stem.length && stem[i] === name[i]) i++;
    return i;
  };
  return [...notes].sort((a, b) => shared(b) - shared(a) || a.localeCompare(b))[0]!;
}

/**
 * Moves every picture a note shows into the folder of that note, moving a flat note (`dir/stem.md`) into its own
 * folder (`dir/stem/stem.md`) first, and rewrites the links to both. A picture is fine where it is when it sits in
 * (or below) the own folder of a note that shows it, or anywhere in `Sources/`. `notes` limits it to the pictures those notes show. Pages
 * changed between the read and the write fail the whole run before anything moves.
 */
export async function tidyAttachments(root: string, opts: { notes?: string[]; dryRun?: boolean } = {}): Promise<TidyResult> {
  let paths = (await listTree(root)).filter((f) => f.type === 'file').map((f) => f.path);
  const texts = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const p of paths.filter(isPage)) {
    const buf = await readFile(join(root, p));
    texts.set(p, buf.toString('utf8'));
    versions.set(p, versionOf(buf));
  }

  const shownBy = new Map<string, string[]>();
  for (const [page, text] of texts)
    for (const f of linkedFiles(text, page, paths)) if (isImage(f)) shownBy.set(f, [...(shownBy.get(f) ?? []), page]);
  const scope = opts.notes && new Set(opts.notes);

  // Virtual state: `origin` maps a current path to the file it was on disk.
  const origin = new Map(paths.map((p) => [p, p]));
  const lower = () => new Set(paths.map((p) => p.toLowerCase()));
  const moved: TidyResult['moved'] = [];
  const skipped: TidyResult['skipped'] = [];
  const changed = new Set<string>();
  const current = (p: string) => moved.reduce((at, m) => (m.from === at ? m.to : at), p);

  const apply = (from: string, to: string, relink: typeof relinkFile) => {
    for (const [page, text] of [...texts]) {
      const next = relink(text, page, from, to, paths);
      if (next !== text) { texts.set(page, next); changed.add(origin.get(page)!); }
    }
    if (texts.has(from)) { texts.set(to, texts.get(from)!); texts.delete(from); }
    origin.set(to, origin.get(from)!);
    origin.delete(from);
    paths = paths.map((p) => (p === from ? to : p));
    moved.push({ from, to });
  };

  for (const [image, notes] of shownBy) {
    if (inSources(image) || (scope && !notes.some((n) => scope.has(n)))) continue;
    if (notes.some((n) => { const f = ownFolder(n); return f !== null && inFolder(image, f); })) continue;
    const note = current(owner(image, notes));
    let folder = ownFolder(note);
    if (folder === null) {
      folder = attachmentFolder(note).folder;
      // A folder of that name in other case is the note's folder: no case twin next to it.
      folder = [...new Set(paths.map(dirOf))].find((d) => d.toLowerCase() === folder!.toLowerCase()) ?? folder;
      const to = `${folder}/${base(note)}`;
      if (paths.some((p) => p.toLowerCase() === folder!.toLowerCase())) {
        skipped.push({ path: image, reason: `${folder} is a file, so ${note} can't move into its own folder` });
        continue;
      }
      if (lower().has(to.toLowerCase())) {
        skipped.push({ path: image, reason: `${to} already exists, so ${note} can't move into its own folder` });
        continue;
      }
      apply(note, to, rewriteLinks);
    }
    const to = `${folder}/${base(image)}`;
    if (lower().has(to.toLowerCase())) {
      skipped.push({ path: image, reason: `${to} already exists` });
      continue;
    }
    apply(image, to, relinkFile);
  }

  const rewritten = [...texts.keys()].filter((p) => changed.has(origin.get(p)!));
  if (opts.dryRun || !moved.length) return { moved, rewritten, skipped };

  for (const p of rewritten) {
    const was = origin.get(p)!;
    if ((await versionOfFile(join(root, was))) !== versions.get(was)) throw new Error(`${was} changed while tidying; run again`);
  }
  for (const p of paths) {
    const was = origin.get(p)!;
    if (was === p) continue;
    await mkdir(join(root, dirOf(p)), { recursive: true });
    await rename(join(root, was), join(root, p));
  }
  for (const p of rewritten) await writeFile(join(root, p), texts.get(p)!);
  return { moved, rewritten, skipped };
}
