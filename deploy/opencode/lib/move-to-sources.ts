import { lstat, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * The move_to_sources move (import-free, so the backend tests load it): one ingested item `Input/<name>`
 * becomes `Sources/<name>`. Never overwrites, never copies. Throws on any refusal, which the AI sees as a
 * tool error.
 */

/** A real directory, not a symlink; `null` when nothing is there. */
async function dirAt(path: string, label: string): Promise<boolean | null> {
  const st = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!st) return null;
  if (st.isSymbolicLink()) throw new Error(`${label} is a symlink: refused`);
  return st.isDirectory();
}

/** True if the item's `index.md` frontmatter still lists `unresolved_links` (the ingest service is fetching them). */
function hasOpenLinks(index: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(index)?.[1];
  if (!fm) return false;
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^unresolved_links:/.test(l));
  if (i < 0) return false;
  const inline = lines[i]!.slice('unresolved_links:'.length).trim();
  if (inline) return !/^\[\s*\]$/.test(inline) && inline !== 'null' && inline !== '~';
  // Block list: the indented `- …` lines that follow.
  return /^\s*-\s/.test(lines[i + 1] ?? '');
}

/** A moved file, vault-relative: where it was and where it is now (the shape apply_patch reports too). */
export interface MovedFile { filePath: string; movePath: string }

/**
 * Moves `Input/<name>` to `Sources/<name>`. Returns the tool output and every moved file, so the backend marks
 * each one as changed by the AI.
 */
export async function moveToSources(dir: string, name: string): Promise<{ output: string; files: MovedFile[] }> {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || name.startsWith('.')) throw new Error(`not an input item name: ${JSON.stringify(name)}`);
  if ((await dirAt(join(dir, 'Input'), 'Input')) === null) throw new Error(`no input item Input/${name}`);
  if ((await dirAt(join(dir, 'Input', name), `Input/${name}`)) !== true) throw new Error(`no input item Input/${name}`);
  const sources = await dirAt(join(dir, 'Sources'), 'Sources');
  if (sources === false) throw new Error('Sources is not a folder');
  const index = await readFile(join(dir, 'Input', name, 'index.md'), 'utf8').catch(() => '');
  if (hasOpenLinks(index)) throw new Error(`Input/${name} is still being processed (unresolved_links): leave it for the next ingest`);
  if (sources === null) await mkdir(join(dir, 'Sources'));
  if ((await lstat(join(dir, 'Sources', name)).catch(() => null)) !== null) throw new Error(`Sources/${name} exists: rename or merge by hand`);
  const from = join(dir, 'Input', name);
  const rels = (await readdir(from, { recursive: true, withFileTypes: true }))
    .filter((e) => !e.isDirectory())
    .map((e) => relative(from, join(e.parentPath, e.name)));
  await rename(from, join(dir, 'Sources', name));
  return { output: `Moved to Sources/${name}`, files: rels.map((r) => ({ filePath: `Input/${name}/${r}`, movePath: `Sources/${name}/${r}` })) };
}
