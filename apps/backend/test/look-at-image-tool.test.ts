import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRequest, describeImage, resolveImage, visionConfig } from '../../../deploy/opencode/lib/look-at-image.js';
import { testDir } from './opencode-container.js';

// The look_at_image tool's logic, on a real directory and a real local HTTP server standing in for the
// vision gateway (the tool itself runs inside opencode; see opencode-tools.test.ts and look-at-image.llm.test.ts).

const base = testDir('look-at-image');
const vault = join(base, 'vault');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let server: Server;
let origin: string;
let seen: { auth?: string; body: { provider?: unknown; messages: { content: { image_url: { url: string } }[] }[] } }[] = [];

beforeAll(async () => {
  await mkdir(join(vault, 'Photos'), { recursive: true });
  await mkdir(join(vault, '.hidden'), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
  for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'UP.PNG']) await writeFile(join(vault, 'Photos', name), PNG);
  await writeFile(join(vault, 'Photos/doc.pdf'), '%PDF-1.4');
  await writeFile(join(vault, 'Photos/logo.svg'), '<svg/>');
  await writeFile(join(vault, 'Photos/big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await writeFile(join(vault, '.hidden/x.png'), PNG);
  await writeFile(join(base, 'other/secret.png'), PNG);
  await symlink(join(base, 'other'), join(vault, 'escape'));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/fail/chat/completions') return void res.writeHead(401).end('{"error":"bad key sk-SECRET-KEY"}');
      if (req.url === '/empty/chat/completions') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}');
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const text = req.url === '/long/chat/completions' ? 'x'.repeat(9000) : 'A red square.';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

const env = (path = '', extra: Record<string, string> = {}) => ({ VISION_BASE_URL: origin + path, VISION_MODEL: 'vl', ...extra });

describe('resolveImage', () => {
  it.each(['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'UP.PNG'])('accepts %s', async (name) => {
    const r = await resolveImage(vault, `Photos/${name}`);
    expect(r.rel).toBe(`Photos/${name}`);
    expect(r.mime).toMatch(/^image\//);
    expect(r.data.length).toBe(PNG.length);
  });
  it('maps extensions to mime types', async () => {
    expect((await resolveImage(vault, 'Photos/b.jpg')).mime).toBe('image/jpeg');
    expect((await resolveImage(vault, 'Photos/a.png')).mime).toBe('image/png');
  });
  it('refuses outside, dot segments, symlinks out and missing files', async () => {
    await expect(resolveImage(vault, '../other/secret.png')).rejects.toThrow(/outside the vault/);
    await expect(resolveImage(vault, '.hidden/x.png')).rejects.toThrow(/no such note/);
    await expect(resolveImage(vault, 'escape/secret.png')).rejects.toThrow(/outside the vault/);
    await expect(resolveImage(vault, 'Photos/nope.png')).rejects.toThrow(/no such note/);
  });
  it('refuses pdf, svg and oversized files', async () => {
    await expect(resolveImage(vault, 'Photos/doc.pdf')).rejects.toThrow(/png, jpg, gif or webp/);
    await expect(resolveImage(vault, 'Photos/logo.svg')).rejects.toThrow(/png, jpg, gif or webp/);
    await expect(resolveImage(vault, 'Photos/big.png')).rejects.toThrow(/too large/);
  });
});

describe('buildRequest', () => {
  it('has the data URL, the question and the model options', () => {
    const req = buildRequest({ mime: 'image/png', data: PNG }, 'What colour?', { model: 'vl', options: { provider: { zdr: true } } });
    expect(req).toMatchObject({ model: 'vl', stream: false, provider: { zdr: true } });
    const content = req.messages[0]!.content;
    expect(content[0]).toEqual({ type: 'text', text: 'What colour?' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
  });
  it('asks for a thorough description by default', () => {
    expect(buildRequest({ mime: 'image/png', data: PNG }, undefined, { model: 'vl', options: {} }).messages[0]!.content[0]).toMatchObject({ text: expect.stringMatching(/describe.*transcrib/i) });
  });
});

describe('visionConfig', () => {
  const venv = { VISION_MODEL: 'vl', VISION_REQUEST_OPTIONS: '{"provider":{"zdr":true}}', VISION_MODEL_OPTIONS: '{"big":{"provider":{"order":["x"]}}}' };
  const override = async (content: string) => {
    const file = join(base, `vision-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, content);
    return file;
  };
  it('an override file picks the model and its options from VISION_MODEL_OPTIONS', async () => {
    expect(await visionConfig(venv, await override('{"model":"big"}'))).toEqual({ model: 'big', options: { provider: { order: ['x'] } } });
  });
  it('a model without options gets none', async () => {
    expect(await visionConfig(venv, await override('{"model":"other"}'))).toEqual({ model: 'other', options: {} });
  });
  it('a missing or broken file keeps VISION_MODEL', async () => {
    const want = { model: 'vl', options: { provider: { zdr: true } } };
    expect(await visionConfig(venv, join(base, 'no-such.json'))).toEqual(want);
    expect(await visionConfig(venv, await override('not json'))).toEqual(want);
    expect(await visionConfig(venv, await override('{"model":""}'))).toEqual(want);
  });
});

describe('describeImage', () => {
  it('posts to the gateway with the key and returns the text', async () => {
    seen = [];
    const out = await describeImage(vault, 'Photos/a.png', 'What colour?', env('', { VISION_API_KEY: 'sk-1', VISION_REQUEST_OPTIONS: '{"provider":{"zdr":true}}' }));
    expect(out).toBe('A red square.');
    expect(seen[0]!.auth).toBe('Bearer sk-1');
    expect(seen[0]!.body.provider).toEqual({ zdr: true });
    expect(seen[0]!.body.messages[0]!.content[1]!.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
  it('sends no Authorization without a key', async () => {
    seen = [];
    await describeImage(vault, 'Photos/a.png', undefined, env());
    expect(seen[0]!.auth).toBeUndefined();
  });
  it('cuts long answers', async () => {
    expect((await describeImage(vault, 'Photos/a.png', undefined, env('/long'))).length).toBeLessThanOrEqual(8100);
  });
  it('is not configured without the vision env', async () => {
    await expect(describeImage(vault, 'Photos/a.png', undefined, {})).rejects.toThrow('image recognition is not configured');
  });
  it('reports HTTP errors without the key', async () => {
    const err = await describeImage(vault, 'Photos/a.png', undefined, env('/fail', { VISION_API_KEY: 'sk-SECRET-KEY' })).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain('sk-SECRET-KEY');
  });
  it('reports an answer without text', async () => {
    await expect(describeImage(vault, 'Photos/a.png', undefined, env('/empty'))).rejects.toThrow(/no description/);
  });
  it('refuses a bad path before any request', async () => {
    seen = [];
    await expect(describeImage(vault, 'Photos/doc.pdf', undefined, env())).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
