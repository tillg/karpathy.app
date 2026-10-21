// An HTML page's Read mode (#126): the file's HTML made inert and self-contained for a sandboxed
// `srcdoc` frame. The frame inherits the app's CSP (no inline scripts, images only from `self`/`data:`,
// inline styles allowed), so vault stylesheets go in as `<style>` and vault images as `data:` URLs.
import DOMPurify from 'dompurify';
import { formatRoute } from './route';

export interface PageCtx {
  vault: string;
  /** The page's own path: relative links resolve from its folder. */
  path: string;
  /** Every vault file path (the tree's list). */
  paths: readonly string[];
  /** A vault file's bytes (`GET /raw`), null when it can't be read. */
  load(path: string): Promise<{ type: string; bytes: ArrayBuffer } | null>;
  /** Images over this size are left out (their alt text stays). */
  maxBytes: number;
}

const REMOTE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** The rendered page's frame: nothing in it runs, and it can't reach the app's token, storage or DOM. */
export const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';
/** Images bigger than this stay out of a rendered page (their alt text shows). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** A relative reference → the vault path it names; null when it leaves the vault root or names no file. */
function resolve(ref: string, from: string, paths: readonly string[]): string | null {
  let target: string;
  try { target = decodeURI(ref.split(/[?#]/)[0]!); } catch { return null; }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  const p = parts.join('/');
  return paths.includes(p) ? p : null;
}

export function dataUrl(type: string, bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

export async function preparePage(html: string, ctx: PageCtx): Promise<string> {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['link', 'style'],
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'base', 'meta', 'script', 'frame', 'frameset'],
    FORBID_ATTR: ['srcset'],
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const local = (ref: string | null) => (ref && !REMOTE.test(ref) && !ref.startsWith('#') ? resolve(ref, ctx.path, ctx.paths) : null);

  for (const link of [...doc.querySelectorAll('link')]) {
    const p = /\bstylesheet\b/i.test(link.getAttribute('rel') ?? '') ? local(link.getAttribute('href')) : null;
    const f = p ? await ctx.load(p) : null;
    if (f) {
      const style = doc.createElement('style');
      style.textContent = new TextDecoder().decode(f.bytes);
      link.replaceWith(style);
    } else link.remove();
  }

  for (const img of [...doc.querySelectorAll('img, source')]) {
    const src = img.getAttribute('src');
    const alt = img.getAttribute('alt') ?? '';
    if (src && REMOTE.test(src) && !src.startsWith('data:')) {
      // As in notes, a remote image stays a link (the CSP wouldn't load it).
      const a = doc.createElement('a');
      a.href = src;
      a.textContent = alt || src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      img.replaceWith(a);
      continue;
    }
    const p = local(src);
    const f = p ? await ctx.load(p) : null;
    if (f && f.bytes.byteLength <= ctx.maxBytes) img.setAttribute('src', dataUrl(f.type, f.bytes));
    else if (src?.startsWith('data:')) continue;
    else img.replaceWith(doc.createTextNode(alt));
  }

  // Image-map areas are links too: none may move the app by itself (a `#` link with target=_top would change its route).
  for (const a of [...doc.querySelectorAll('a[href], area[href]')]) {
    const href = a.getAttribute('href')!;
    if (href.startsWith('#')) { a.removeAttribute('target'); continue; }
    if (REMOTE.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    const p = local(href);
    if (p) {
      // Opens in the app (top window, hash route): Back and the back arrow work as for any link.
      a.setAttribute('href', `/${formatRoute(ctx.vault, p)}`);
      a.setAttribute('target', '_top');
    } else a.removeAttribute('href');
  }

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
