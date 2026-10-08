import { parseWikilink, resolveRelativeLink, resolveWikilink, WIKILINK_RE } from './wikilink.js';

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/** Relative href from the folder `fromDir` to the vault path `target`, spaces as `%20` (all of it encoded with `encoded`). */
function relativeHref(fromDir: string, target: string, encoded = false): string {
  const a = fromDir ? fromDir.split('/') : [];
  const b = target.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const href = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  return encoded ? encodeURI(href) : href.replaceAll(' ', '%20');
}

/** `[start, end)` ranges of fenced code blocks and code spans, which are never rewritten. */
function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  let fence: { marker: string; start: number } | null = null;
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.marker[0] && m[1]!.length >= fence.marker.length) {
        out.push([fence.start, end]);
        fence = null;
      }
    } else if (m) fence = { marker: m[1]!, start: pos };
    else for (const s of line.matchAll(/(`+)[^`]*?\1/g)) out.push([pos + s.index, pos + s.index + s[0].length]);
    pos = end + 1;
  }
  if (fence) out.push([fence.start, text.length]);
  return out;
}

const MD_LINK_RE = /(!?\[[^\]\n]*\]\()([^)\s]+)((?:\s+"[^"\n]*")?\))/g;

/**
 * Rewrites the links in `text` (the page at `page`) for a page moving from `from` to `to`, its own folder
 * (`dir/stem.md` → `dir/stem/stem.md`). `paths` = the vault's files before the move.
 *
 * - Path-form wikilinks (`[[serien/foo]]`) and Markdown links that resolve to `from` point to `to`;
 *   bare wikilinks still resolve by name and stay as they are.
 * - In the moved page itself (`page === from`), relative Markdown links get one level deeper.
 * - Code blocks and code spans are left alone.
 */
export function rewriteLinks(text: string, page: string, from: string, to: string, paths: readonly string[]): string {
  let code = codeRanges(text);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const folder = to.split('/').at(-2)!;
  const moved = page === from;

  let out = text.replace(WIKILINK_RE, (all, inner: string, offset: number) => {
    const cut = inner.search(/[#|]/);
    const target = cut < 0 ? inner : inner.slice(0, cut);
    const t = target.trim();
    if (inCode(offset) || !t.includes('/') || resolveWikilink(t, paths, page) !== from) return all;
    const slash = target.lastIndexOf('/');
    return `[[${target.slice(0, slash + 1)}${folder}/${target.slice(slash + 1)}${cut < 0 ? '' : inner.slice(cut)}]]`;
  });

  code = codeRanges(out);
  out = out.replace(MD_LINK_RE, (all, head: string, href: string, tail: string, offset: number) => {
    if (inCode(offset) || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return all;
    const suffix = /[?#].*$/.exec(href)?.[0] ?? '';
    const bare = href.slice(0, href.length - suffix.length);
    if (resolveRelativeLink(href, page, paths) === from) {
      const keepMd = /\.md$/i.test(bare);
      // A link written percent-encoded (`M%C3%BCnchen.md`) stays so.
      const encoded = /%(?!20)[0-9a-f]{2}/i.test(bare);
      const next = href.startsWith('/') ? `/${encoded ? encodeURI(to) : to.replaceAll(' ', '%20')}` : relativeHref(dirOf(moved ? to : page), to, encoded);
      return `${head}${keepMd ? next : next.replace(/\.md$/i, '')}${suffix}${tail}`;
    }
    if (!moved || href.startsWith('/')) return all;
    return `${head}../${bare}${suffix}${tail}`;
  });
  return out;
}

/**
 * Notes the page at `page` links to (wikilinks, embeds and relative Markdown links), resolved against
 * `paths`, deduplicated, in order of appearance. Only `.md` targets count; self links and code are skipped.
 */
export function noteLinks(text: string, page: string, paths: readonly string[]): string[] {
  const code = codeRanges(text);
  const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
  const found: [number, string | null][] = [
    ...[...text.matchAll(WIKILINK_RE)].map((m) => [m.index, resolveWikilink(parseWikilink(m[1]!).target, paths, page)] as [number, string | null]),
    ...[...text.matchAll(MD_LINK_RE)].map((m) => [m.index, resolveRelativeLink(m[2]!, page, paths)] as [number, string | null]),
  ];
  const out = new Set<string>();
  for (const [i, p] of found.sort((a, b) => a[0] - b[0]))
    if (p && p !== page && /\.md$/i.test(p) && !inCode(i)) out.add(p);
  return [...out];
}
