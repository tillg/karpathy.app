import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { resolveNote } from './resolve-note.js';

// The look_at_image tool's logic (import-free of opencode, so the backend tests load it): reads an image of the
// vault and asks the vision model (an OpenAI-compatible /chat/completions endpoint) what it shows.

type Env = Record<string, string | undefined>;

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ANSWER = 8000;
const TIMEOUT_MS = 120_000;
const DEFAULT_QUESTION = 'Describe this image thoroughly: what it shows, its layout, colours and any people, objects or places. Transcribe all text in it exactly.';

/** The egress proxy for `url`'s scheme (same rule as save_url). */
const proxyFor = (url: string, env: Env) =>
  (url.toLowerCase().startsWith('https:') ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy) || undefined;

/** The image at vault-relative `path`: checked like open_note, then png/jpg/gif/webp (no SVG, no PDF) up to 10 MB. */
export async function resolveImage(dir: string, path: string): Promise<{ rel: string; mime: string; data: Buffer }> {
  const rel = await resolveNote(dir, path);
  const mime = MIME[extname(rel).toLowerCase()];
  if (!mime) throw new Error(`not an image look_at_image can read (png, jpg, gif or webp only): ${rel}`);
  const file = resolve(dir, rel);
  if ((await stat(file)).size > MAX_BYTES) throw new Error(`image too large (over 10 MB): ${rel}`);
  return { rel, mime, data: await readFile(file) };
}

/** The chat-completions body: the question and the image as a data URL, plus the model's request options (ZDR routing). */
export function buildRequest(image: { mime: string; data: Buffer }, question: string | undefined, env: Env) {
  const options = env.VISION_REQUEST_OPTIONS ? (JSON.parse(env.VISION_REQUEST_OPTIONS) as Record<string, unknown>) : {};
  return {
    model: env.VISION_MODEL,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: question?.trim() || DEFAULT_QUESTION },
        { type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${image.data.toString('base64')}` } },
      ],
    }],
    max_tokens: 2000,
    stream: false,
    ...options,
  };
}

/** Asks the vision model about the image at `path`; throws (a tool error) when unconfigured or the gateway fails. */
export async function describeImage(dir: string, path: string, question: string | undefined, env: Env): Promise<string> {
  if (!env.VISION_BASE_URL || !env.VISION_MODEL) throw new Error('image recognition is not configured');
  const image = await resolveImage(dir, path);
  const url = `${env.VISION_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  // `proxy` is Bun's fetch option (opencode runs on Bun); Bun's own NO_PROXY keeps the dev model relay direct.
  const res = await fetch(url, {
    method: 'POST',
    proxy: proxyFor(url, env),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...(env.VISION_API_KEY ? { authorization: `Bearer ${env.VISION_API_KEY}` } : {}) },
    body: JSON.stringify(buildRequest(image, question, env)),
  } as RequestInit);
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replaceAll(env.VISION_API_KEY ?? '\0', '[key]').slice(0, 300);
    throw new Error(`the vision model failed: HTTP ${res.status} ${body}`.trim());
  }
  const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = json?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw new Error('the vision model returned no description');
  return text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : text;
}
