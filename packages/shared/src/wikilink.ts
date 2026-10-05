/** `[[target#heading|alias]]` — matched in raw Markdown text. */
export const WIKILINK_RE = /\[\[([^[\]\n]+?)\]\]/g;

export interface Wikilink {
  target: string;
  heading?: string;
  alias?: string;
}

export function parseWikilink(inner: string): Wikilink {
  const bar = inner.indexOf('|');
  const ref = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : undefined;
  const hash = ref.indexOf('#');
  const target = (hash >= 0 ? ref.slice(0, hash) : ref).trim();
  const heading = hash >= 0 ? ref.slice(hash + 1).trim() : undefined;
  return { target, ...(heading ? { heading } : {}), ...(alias ? { alias } : {}) };
}

/** Text shown for a link: alias, else the last path segment of the target. */
export function wikilinkLabel(l: Wikilink): string {
  return l.alias ?? (l.target.split('/').pop() || l.heading || '');
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// One lookup set per file list (a note can have many links and embeds).
const sets = new WeakMap<readonly string[], Set<string>>();
const pathSet = (paths: readonly string[]) => {
  let s = sets.get(paths);
  if (!s) sets.set(paths, (s = new Set(paths)));
  return s;
};

const dir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const depth = (p: string) => p.split('/').length;

/** Among several matches: the one in `from`'s folder, then the shortest path, then A–Z (case-insensitive). */
function pick(matches: string[], from?: string): string | undefined {
  const here = from === undefined ? undefined : dir(from);
  return [...matches].sort((a, b) =>
    Number(dir(b) === here) - Number(dir(a) === here) || depth(a) - depth(b) || a.toLowerCase().localeCompare(b.toLowerCase()))[0];
}

/**
 * Resolves a link target to a vault path: exact path, then path + `.md`, then a path ending in
 * `/target(.md)`, then a basename match anywhere (case-insensitive). With several matches, the one in
 * the folder of `from` (the open note) wins, then the shortest path, then A–Z. Null when nothing matches.
 */
export function resolveWikilink(target: string, paths: readonly string[], from?: string): string | null {
  const t = target.replace(/^\/+/, '');
  if (!t) return null;
  const set = pathSet(paths);
  if (set.has(t)) return t;
  if (set.has(`${t}.md`)) return `${t}.md`;
  const suffix = pick(paths.filter((p) => p.endsWith(`/${t}.md`) || p.endsWith(`/${t}`)), from);
  if (suffix) return suffix;
  const name = base(t).toLowerCase();
  return pick(paths.filter((p) => {
    const b = base(p).toLowerCase();
    return b === name || b === `${name}.md`;
  }), from) ?? null;
}

/**
 * Resolves a relative Markdown link (`../Wiki/index.md#h`, `My%20Note`) from the note at `from` to
 * a vault path: relative to the note's folder (leading `/` = vault root), `.md` optional. Null for
 * URLs with a scheme, in-page anchors, missing files and paths above the vault root.
 */
export function resolveRelativeLink(href: string, from: string, paths: readonly string[]): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let rel = href.replace(/[?#].*$/, '');
  try { rel = decodeURIComponent(rel); } catch { return null; }
  const parts = rel.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  const p = parts.join('/');
  if (!p) return null;
  return paths.includes(p) ? p : paths.includes(`${p}.md`) ? `${p}.md` : null;
}
