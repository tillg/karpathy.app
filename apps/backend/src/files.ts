import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileEntry, SearchHit } from '@karpathy/shared';

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

/** Recursive listing of the vault root; dot-entries (.git, .obsidian, .claude, …) are hidden. */
export async function listTree(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
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

export const MAX_HITS = 200;

/** Words of a query: whitespace-separated, or "quoted phrases" kept whole. */
export function queryTerms(q: string): string[] {
  const terms = [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  return terms.length > 0 ? terms : [q];
}

/**
 * ripgrep over the vault root (fixed strings, case-insensitive), sorted by path so results are
 * stable. A multi-word query finds files containing ALL words (in content or path) and shows the
 * lines matching any of them. Files whose name matches but whose content doesn't get one name
 * hit (line 0). Files whose base name contains every word come first.
 */
export async function search(root: string, q: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const terms = queryTerms(q).map((t) => t.toLowerCase());
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'rg',
      ['--json', '--sort', 'path', '--fixed-strings', '--ignore-case', '--max-count', '20', '--max-columns', '300', ...terms.flatMap((t) => ['-e', t]), '--', '.'],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
      (err, out) => {
        // Exit code 1 = no matches.
        if (err && (err as { code?: number }).code !== 1) reject(err);
        else resolve(out);
      },
    );
  });
  let content: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{"type":"match"')) continue;
    const m = JSON.parse(line) as { data: { path: { text?: string }; line_number: number; lines: { text?: string } } };
    const path = (m.data.path.text ?? '').replace(/^\.\//, '');
    // A path that isn't UTF-8 comes as `path.bytes`: it can't be opened in the app anyway.
    if (!path) continue;
    content.push({ path, line: m.data.line_number, text: (m.data.lines.text ?? '').trimEnd() });
  }
  if (terms.length > 1) {
    const ok = new Map<string, boolean>();
    for (const path of new Set(content.map((h) => h.path))) {
      // The AI or a pull may delete or rename it between rg and this read: then it doesn't match.
      const text = await readFile(join(root, path), 'utf8').catch(() => null);
      const hay = path.toLowerCase() + '\n' + (text ?? '').toLowerCase();
      ok.set(path, text !== null && terms.every((t) => hay.includes(t)));
    }
    content = content.filter((h) => ok.get(h.path));
  }
  const withContent = new Set(content.map((h) => h.path));
  const byName = (await listTree(root))
    .filter((f) => f.type === 'file' && terms.every((t) => f.path.toLowerCase().includes(t)) && !withContent.has(f.path))
    .map((f) => ({ path: f.path, line: 0, text: f.path }));
  const nameMatches = (path: string) => {
    const base = (path.split('/').pop() ?? path).replace(/\.md$/i, '').toLowerCase();
    return terms.every((t) => base.includes(t));
  };
  const hits = [
    ...byName.filter((h) => nameMatches(h.path)),
    ...content.filter((h) => nameMatches(h.path)),
    ...byName.filter((h) => !nameMatches(h.path)),
    ...content.filter((h) => !nameMatches(h.path)),
  ];
  return { hits: hits.slice(0, MAX_HITS), truncated: hits.length > MAX_HITS };
}
