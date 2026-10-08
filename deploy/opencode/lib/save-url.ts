import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The save_url download (import-free, so the backend tests load it): fetches one http(s) URL and writes it
 * as a new media file or PDF inside the vault. Throws on any refusal, which the AI sees as a tool error.
 */

/**
 * What the AI may save: the media table (packages/shared/src/media.ts, MEDIA; a test keeps them in sync)
 * without SVG (it can carry script), plus PDF. The image has no packages/, hence the copy.
 */
export const SAVE_TYPES = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp',
  'mp4', 'webm', 'mov', 'm4v', 'ogv',
  'mp3', 'm4a', 'wav', 'ogg', 'flac', 'opus',
  'pdf',
] as const;
const VIDEO = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
const AUDIO = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'opus'];

/** Same cap as an upload (MAX_UPLOAD_BYTES): the file stays in the git history for good. */
export const MAX_SAVE_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

type Env = Record<string, string | undefined>;
const MAX_REDIRECTS = 5;
/** Wikimedia, the usual source of pictures, answers 429 to generic clients (its User-Agent policy). */
const USER_AGENT = 'karpathy.app-save_url/1.0 (+https://github.com/tillg/karpathy.app)';

/** The egress proxy for `url`'s scheme. */
export function proxyFor(url: string, env: Env): string | undefined {
  const https = url.toLowerCase().startsWith('https:');
  return (https ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy) || undefined;
}

/** Content-Types a server may send for a file of extension `ext` (octet-stream: CDNs send it for anything). */
function typeFits(ext: string, type: string): boolean {
  if (type === 'application/octet-stream' || type === 'binary/octet-stream') return true;
  if (ext === 'pdf') return type === 'application/pdf';
  if (VIDEO.includes(ext)) return type.startsWith('video/');
  // .ogg is audio in the media table, but servers send it as either.
  if (AUDIO.includes(ext)) return type.startsWith('audio/') || (ext === 'ogg' && type.startsWith('video/'));
  return type.startsWith('image/') && type !== 'image/svg+xml';
}

/**
 * True if Bun would fetch `host` without the proxy: Bun honors NO_PROXY even for an explicit `proxy` option
 * (compose sets localhost and 127.0.0.1 there, for opencode's own API). Entries match exactly or as a domain
 * suffix, case-insensitively; `*` matches all. `host` comes from a WHATWG URL, so 127.1 and 2130706433 are
 * already 127.0.0.1.
 */
function bypassesProxy(host: string, env: Env): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return (env.NO_PROXY ?? env.no_proxy ?? '').split(',').some((raw) => {
    const e = raw.trim().toLowerCase().replace(/^\*?\./, '').replace(/:\d+$/, '');
    return e === '*' || (e !== '' && (h === e || h.endsWith(`.${e}`)));
  });
}

const size = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`);

/** `filePath` (vault-relative or absolute) as an absolute path for a new media file or PDF inside `dir`. */
async function target(dir: string, filePath: string): Promise<{ abs: string; rel: string; ext: string }> {
  const root = await realpath(dir);
  const rel = relative(root, resolve(root, filePath));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`outside the vault: ${filePath}`);
  if (rel.split(sep).some((s) => s.startsWith('.'))) throw new Error(`hidden path: ${rel}`);
  const name = rel.split(sep).pop()!;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!(SAVE_TYPES as readonly string[]).includes(ext))
    throw new Error(`only images, videos, audio and PDFs can be saved (${SAVE_TYPES.join(', ')}), not ${rel}`);
  // The deepest existing ancestor must resolve inside the vault: a symlinked folder must not lead out.
  let probe = dirname(resolve(root, rel));
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      const r = relative(root, real);
      if (r.startsWith('..') || isAbsolute(r)) throw new Error(`outside the vault: ${filePath}`);
      break;
    }
    probe = dirname(probe);
  }
  return { abs: resolve(root, rel), rel: rel.split(sep).join('/'), ext };
}

/**
 * Downloads `url` (through `opts.proxy` when given) to the new file `filePath` in `dir`. Never overwrites;
 * removes a partial file on any failure. Returns the tool output: the saved path and the embed to add.
 */
export async function saveUrl(dir: string, url: string, filePath: string, opts: { proxy?: string; env?: Env; maxBytes?: number } = {}): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL('invalid:');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http(s) URLs can be saved: ${url}`);
  const max = opts.maxBytes ?? MAX_SAVE_BYTES;
  const t = await target(dir, filePath);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  // Redirects by hand: every hop must pass the NO_PROXY check, so none reaches an internal host directly.
  let res: Response;
  for (let hops = 0; ; hops++) {
    if (bypassesProxy(parsed.hostname, opts.env ?? {})) throw new Error(`internal host refused: ${parsed.hostname}`);
    // `proxy` is Bun's fetch option (opencode runs on Bun).
    res = await fetch(parsed.href, { proxy: opts.proxy, redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT } } as RequestInit);
    const location = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || location === null) break;
    if (hops === MAX_REDIRECTS) throw new Error('too many redirects');
    parsed = new URL(location, parsed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http(s) URLs can be saved: ${parsed.href}`);
  }
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!typeFits(t.ext, type)) throw new Error(`not a ${t.ext} file: the server sent ${type || 'no type'}`);
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error(`larger than ${size(max)}`);
  await mkdir(dirname(t.abs), { recursive: true });
  const fh = await open(t.abs, 'wx').catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'EEXIST' ? new Error(`already exists: ${t.rel}; choose another name`) : e;
  });
  let n = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      n += chunk.byteLength;
      if (n > max) throw new Error(`larger than ${size(max)}`);
      await fh.write(chunk);
    }
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(t.abs).catch(() => undefined);
    throw e;
  }
  return `saved ${t.rel} (${size(n)}). Embed it in a note with ![[${t.rel}]]`;
}
