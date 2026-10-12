// Embeds (`![[a.png|300]]`, `![alt](path)`): parsing, resolving to a vault file, and the object-URL
// cache that holds the bytes. The bytes come from `GET /raw` with the bearer token, so they can't be
// a plain `src`: they are fetched and shown through `blob:` object URLs.
import { mediaKind, type MediaKind } from '@karpathy/shared';
import DOMPurify from 'dompurify';
import { api } from './api';
import { resolveWikilink } from './wikilink';

export { mediaKind, type MediaKind };

/** A media file up to this size loads by itself; a bigger one shows a file card with "Load anyway". */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;
/** Total size of the bytes held in object URLs; the least recently used are dropped beyond it. */
const BUDGET = 200 * 1024 * 1024;

export interface Embed {
  form: 'wiki' | 'md';
  /** The file or note named, without `#heading`; the Markdown form is URL-decoded. */
  target: string;
  /** Wiki form: the whole text between the brackets, for a link when the target turns out to be a note. */
  inner?: string;
  width?: number;
  alt?: string;
}

export type Resolved =
  | { state: 'media'; path: string; kind: MediaKind; width?: number; alt?: string }
  | { state: 'file'; path: string }
  | { state: 'note'; inner: string }
  | { state: 'missing'; target: string }
  | { state: 'remote'; href: string; alt?: string };

/** `![[target|300]]` / `![[target|300x200]]` (width; the height is ignored) / `![[target|Caption]]`. */
export function wikiEmbed(inner: string): Embed {
  const bar = inner.indexOf('|');
  // `\|`: the table-safe bar.
  const ref = (bar >= 0 ? inner.slice(0, inner[bar - 1] === '\\' ? bar - 1 : bar) : inner).trim();
  const extra = bar >= 0 ? inner.slice(bar + 1).trim() : '';
  const hash = ref.indexOf('#');
  const w = /^(\d+)(?:x\d+)?$/.exec(extra);
  return {
    form: 'wiki', target: hash >= 0 ? ref.slice(0, hash).trim() : ref, inner,
    ...(w ? { width: Number(w[1]) } : extra ? { alt: extra } : {}),
  };
}

/** `![alt](path)`; `href` as written (URL-encoded), an optional `"title"` is ignored. */
export function mdEmbed(href: string, alt?: string): Embed {
  let target = href.trim().replace(/\s+"[^"]*"$/, '').replace(/^<(.*)>$/, '$1');
  try { target = decodeURIComponent(target); } catch { /* keep as written */ }
  return { form: 'md', target, ...(alt ? { alt } : {}) };
}

/** The embed in `raw` (the whole `![[…]]` or `![alt](src)` text), or null when it isn't one. */
export function parseEmbed(raw: string): Embed | null {
  const w = /^!\[\[([^[\]\n]+?)\]\]$/.exec(raw);
  if (w) return wikiEmbed(w[1]!);
  const m = /^!\[([^\]]*)\]\((.+)\)$/.exec(raw);
  return m ? mdEmbed(m[2]!, m[1]) : null;
}

/** Both embed forms in a line (the Markdown form allows one level of parentheses: `photo (1).png`). */
export const EMBED_RE = /!\[\[([^[\]\n]+?)\]\]|!\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;

const REMOTE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function classify(path: string, e: Embed, inner: string): Resolved {
  const kind = mediaKind(path);
  if (kind) return { state: 'media', path, kind, ...(e.width ? { width: e.width } : {}), ...(e.alt ? { alt: e.alt } : {}) };
  return /\.md$/i.test(path) ? { state: 'note', inner } : { state: 'file', path };
}

/**
 * Finds the file an embed asks for. The wiki form resolves like a `[[link]]` (extension kept); the
 * Markdown form is a path relative to the note (`notePath`), or to the vault root when `notePath` is null (chat).
 */
export function resolveEmbed(e: Embed, notePath: string | null, paths: readonly string[]): Resolved {
  if (e.form === 'wiki') {
    const p = resolveWikilink(e.target, paths, notePath ?? undefined);
    return p ? classify(p, e, e.inner ?? e.target) : { state: 'missing', target: e.target };
  }
  if (REMOTE.test(e.target)) return { state: 'remote', href: e.target, ...(e.alt ? { alt: e.alt } : {}) };
  const parts = e.target.startsWith('/') || notePath === null ? [] : notePath.split('/').slice(0, -1);
  for (const seg of e.target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return { state: 'missing', target: e.target }; parts.pop(); } else parts.push(seg);
  }
  const p = parts.join('/');
  return p && paths.includes(p) ? classify(p, e, p) : { state: 'missing', target: e.target };
}

// ---- object-URL cache ----

export type Loaded = { url: string; size: number; blob: Blob; release: () => void } | { tooLarge: true; size: number | null };

interface Base { url: string; size: number; blob: Blob }
interface Entry { promise: Promise<Base | { tooLarge: true; size: number | null }>; size: number; url?: string; used: number; refs: number }
const cache = new Map<string, Entry>();
const key = (vault: string, path: string) => `${vault}\0${path}`;
let tick = 0;

const revokeUrl = (e: Entry) => { if (e.url) URL.revokeObjectURL(e.url); e.url = undefined; };
function revoke(k: string) {
  const e = cache.get(k);
  if (e) revokeUrl(e);
  cache.delete(k);
}

/** Drops the least recently used entries that no player holds while the total is over the budget; `keep` stays. */
function evict(keep: string) {
  let total = 0;
  for (const e of cache.values()) total += e.size;
  const old = [...cache.entries()].filter(([k, e]) => k !== keep && e.url && e.refs === 0).sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of old) {
    if (total <= BUDGET) break;
    total -= e.size;
    revoke(k);
  }
}

const lengthOf = (res: Response) => {
  const n = res.headers.get('content-length');
  return n === null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n);
};

/** An SVG shown from a blob URL on the app's origin must not carry script: "open image in new tab" would run it here. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, PARSER_MEDIA_TYPE: 'image/svg+xml' });
}

async function fetchRaw(vault: string, path: string, force: boolean, k: string, entry: Entry): Promise<Base | { tooLarge: true; size: number | null }> {
  if (!force) {
    // Ask the size first (HEAD): a big file is never transferred, not even partly, until the user asks for it.
    // No Content-Length (e.g. a compressed response) = unknown: go on, such types are text-like.
    const size = lengthOf(await api.rawHead(vault, path));
    if (size !== null && size > MAX_PREVIEW_BYTES) {
      if (cache.get(k) === entry) cache.delete(k);
      return { tooLarge: true, size };
    }
  }
  const res = await api.raw(vault, path);
  let blob = await res.blob();
  if (/\.svg$/i.test(path)) blob = new Blob([sanitizeSvg(await blob.text())], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  // Invalidated while loading: the result still serves whoever asked (released later), but isn't cached.
  entry.url = url;
  entry.size = blob.size;
  if (cache.get(k) === entry) evict(k);
  return { url, size: blob.size, blob };
}

/**
 * Object URL for the bytes of a vault file. One fetch per file: later and concurrent calls share it.
 * Over `MAX_PREVIEW_BYTES` it resolves `tooLarge` (not cached, and only a HEAD was sent) unless `force`.
 * Whoever shows the URL must call `release()` when done: held entries are never evicted.
 */
export async function objectUrl(vault: string, path: string, opts: { force?: boolean } = {}): Promise<Loaded> {
  const k = key(vault, path);
  const load = async (force: boolean): Promise<Loaded> => {
    let entry = cache.get(k);
    if (!entry) {
      const fresh: Entry = { promise: undefined as never, size: 0, used: 0, refs: 0 };
      fresh.promise = fetchRaw(vault, path, force, k, fresh).catch((err) => { if (cache.get(k) === fresh) cache.delete(k); throw err; });
      cache.set(k, fresh);
      entry = fresh;
    }
    entry.used = ++tick;
    const e = entry;
    const r = await e.promise;
    if ('tooLarge' in r) return r;
    e.refs++;
    let released = false;
    return { ...r, release: () => {
      if (released) return;
      released = true;
      // The last holder of an entry that is no longer cached frees its URL.
      if (--e.refs <= 0 && cache.get(k) !== e) revokeUrl(e);
    } };
  };
  const r = await load(!!opts.force);
  // A forced call that joined an unforced fetch which gave up on a large file: fetch for real.
  return 'tooLarge' in r && opts.force ? load(true) : r;
}

/** Drops cached bytes (their object URLs are revoked): the given paths of a vault, all of it, or everything. Returns how many. */
export function invalidate(vault?: string, paths?: readonly string[]): number {
  let n = 0;
  for (const k of [...cache.keys()]) {
    const [v, p] = k.split('\0');
    if (vault === undefined || (v === vault && (!paths || paths.includes(p!)))) { revoke(k); n++; }
  }
  return n;
}

/** Size in bytes from a HEAD request; null when it can't be asked (offline, missing). */
export async function fileSize(vault: string, path: string): Promise<number | null> {
  try {
    return lengthOf(await api.rawHead(vault, path));
  } catch { return null; }
}

// Natural sizes of media seen so far, so a skeleton for a known file has its final shape (Back restores the scroll).
const natural = new Map<string, { w: number; h: number }>();
export const rememberNatural = (vault: string, path: string, w: number, h: number) => { if (w && h) natural.set(key(vault, path), { w, h }); };
export const knownNatural = (vault: string, path: string) => natural.get(key(vault, path));
