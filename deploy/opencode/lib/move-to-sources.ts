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

/**
 * True if the item's `index.md` frontmatter still lists `unresolved_links` (the ingest service is fetching them).
 * A small reader for this one key (the lib stays import-free): the key, quoted or not, then either an inline value
 * or the block list below it; blank and comment lines in between are skipped.
 */
function hasOpenLinks(index: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(index)?.[1];
  if (!fm) return false;
  const lines = fm.split(/\r?\n/);
  const key = /^(["']?)unresolved_links\1\s*:(.*)$/;
  const i = lines.findIndex((l) => key.test(l));
  if (i < 0) return false;
  const inline = key.exec(lines[i]!)![2]!.replace(/\s+#.*$/, '').trim();
  if (inline) return !/^\[\s*\]$/.test(inline) && inline !== 'null' && inline !== '~';
  const next = lines.slice(i + 1).find((l) => l.trim() !== '' && !/^\s*#/.test(l));
  return next !== undefined && /^\s*-(\s|$)/.test(next);
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
  // Claim the target with mkdir (fails if anything is there); rename then replaces only this empty folder of ours.
  await mkdir(join(dir, 'Sources', name)).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'EEXIST' ? new Error(`Sources/${name} exists: rename or merge by hand`) : e;
  });
  const from = join(dir, 'Input', name);
  const rels = (await readdir(from, { recursive: true, withFileTypes: true }))
    .filter((e) => !e.isDirectory())
    .map((e) => relative(from, join(e.parentPath, e.name)));
  await rename(from, join(dir, 'Sources', name));
  return { output: `Moved to Sources/${name}`, files: rels.map((r) => ({ filePath: `Input/${name}/${r}`, movePath: `Sources/${name}/${r}` })) };
}
