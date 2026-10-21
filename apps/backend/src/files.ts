import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { noteLinks, type FileEntry, type GraphData } from '@karpathy/shared';

export function versionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Version of a file on disk, or null when it doesn't exist. */
export async function versionOfFile(abs: string): Promise<string | null> {
  try {
    return versionOf(await readFile(abs));
  } catch (e) {
    // ENOTDIR: a deleted file whose folder is now a file (the skill link stub replaced .claude/skills/).
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
    throw e;
  }
}

/**
 * Recursive listing of the vault root; dot-entries (.git, .obsidian, .claude, …) are hidden, except folders
 * named in `visibleDotDirs` (e.g. `.agents`).
 */
export async function listTree(root: string, visibleDotDirs: readonly string[] = []): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') && !(e.isDirectory() && visibleDotDirs.includes(e.name))) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ path: p, type: 'dir' });
        await walk(join(dir, e.name), p);
      } else if (e.isFile()) out.push({ path: p, type: 'file' });
    }
  }
  await walk(root, '');
  return out;
}

/** Markdown files under `root` containing any of `terms` (ripgrep, fixed strings, case-insensitive), sorted. */
export async function filesMentioning(root: string, terms: string[]): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('rg', ['--files-with-matches', '--sort', 'path', '--fixed-strings', '--ignore-case', '--glob', '*.md', ...terms.flatMap((t) => ['-e', t]), '--', '.'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      // Exit code 1 = no matches.
      if (err && (err as { code?: number }).code !== 1) reject(err);
      else resolve(out);
    });
  });
  return stdout.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, ''));
}

/** Every note under `root` and the notes it links to (wikilinks, embeds, relative Markdown links). */
export async function graph(root: string): Promise<GraphData> {
  const paths = (await listTree(root)).filter((f) => f.type === 'file').map((f) => f.path);
  const notes = paths.filter((p) => /\.md$/i.test(p));
  const nodes: GraphData['nodes'] = [];
  const links: GraphData['links'] = [];
  for (const source of notes) {
    // The AI or a pull may delete it between the listing and this read: then it has no links.
    const text = await readFile(join(root, source), 'utf8').catch(() => '');
    const type = noteType(text);
    nodes.push(type ? { path: source, type } : { path: source });
    for (const target of noteLinks(text, source, paths)) links.push({ source, target });
  }
  return { nodes, links };
}

/** The top-level `type:` of a note's frontmatter (a scalar, quotes and comment dropped), if any. */
function noteType(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\n|$)/.exec(text)?.[1];
  const v = fm && /^type:[ \t]*(.*)$/m.exec(fm)?.[1]!.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  return v || undefined;
}
