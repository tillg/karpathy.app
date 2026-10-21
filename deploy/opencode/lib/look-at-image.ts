import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { prompt } from '../../../prompts/load.js';
import { resolveNote } from './resolve-note.js';

// The look_at_image tool's logic (import-free of opencode, so the backend tests load it): reads an image of the
// vault and asks the vision model (an OpenAI-compatible /chat/completions endpoint) what it shows.

type Env = Record<string, string | undefined>;

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ANSWER = 8000;
const TIMEOUT_MS = 120_000;
const DEFAULT_QUESTION = prompt('look-at-image-question').text;

/** The Admin's vision-model override. A literal on purpose: the backend writes it on the shared vaults volume (apps/backend/src/vision-model.ts). */
export const VISION_FILE = '/vaults/.vision.json';

const parseMap = (json: string | undefined): Record<string, Record<string, unknown>> => {
  try {
    const v: unknown = json ? JSON.parse(json) : {};
    return v && typeof v === 'object' ? (v as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
};

/** The vision model and its request options: the override file's model (when readable) else VISION_MODEL; options from VISION_MODEL_OPTIONS, or VISION_REQUEST_OPTIONS for the default model. */
export async function visionConfig(env: Env, file: string): Promise<{ model: string | undefined; options: Record<string, unknown> }> {
  let model = env.VISION_MODEL;
  try {
    const m = (JSON.parse(await readFile(file, 'utf8')) as { model?: unknown } | null)?.model;
    if (typeof m === 'string' && m) model = m;
  } catch { /* missing or broken: keep VISION_MODEL */ }
  if (!model) return { model, options: {} };
  const mapped = parseMap(env.VISION_MODEL_OPTIONS)[model];
  if (mapped && typeof mapped === 'object') return { model, options: mapped };
  return { model, options: model === env.VISION_MODEL ? parseMap(env.VISION_REQUEST_OPTIONS) : {} };
}

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
export function buildRequest(image: { mime: string; data: Buffer }, question: string | undefined, { model, options }: { model: string | undefined; options: Record<string, unknown> }) {
  return {
    model,
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
export async function describeImage(dir: string, path: string, question: string | undefined, env: Env, file = VISION_FILE): Promise<string> {
  const config = await visionConfig(env, file);
  if (!env.VISION_BASE_URL || !config.model) throw new Error('image recognition is not configured');
  const image = await resolveImage(dir, path);
  const url = `${env.VISION_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  // `proxy` is Bun's fetch option (opencode runs on Bun).
  const res = await fetch(url, {
    method: 'POST',
    proxy: proxyFor(url, env),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...(env.VISION_API_KEY ? { authorization: `Bearer ${env.VISION_API_KEY}` } : {}) },
    body: JSON.stringify(buildRequest(image, question, config)),
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
