import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA } from '@karpathy/shared';
import { proxyFor, SAVE_TYPES, saveUrl } from '../../../deploy/opencode/lib/save-url.js';
import { testDir } from './opencode-container.js';

// The save_url tool's download, on a real directory and a real local HTTP server (the tool itself runs
// inside opencode; the proxy path is checked in opencode-tools.test.ts).

const base = testDir('save-url');
const vault = join(base, 'vault');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
let server: Server;
let origin: string;

beforeAll(async () => {
  await mkdir(join(vault, 'notes'), { recursive: true });
  await mkdir(join(base, 'other'), { recursive: true });
  await writeFile(join(vault, 'notes/a.md'), '# A\n');
  await writeFile(join(vault, 'notes/taken.png'), 'old');
  await symlink(join(base, 'other'), join(vault, 'escape'));
  server = createServer((req, res) => {
    const send = (type: string, body: Buffer | string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': type, ...headers });
      res.end(body);
    };
    if (req.url === '/cat.png') return send('image/png', PNG);
    if (req.url === '/blob') return send('application/octet-stream', PNG);
    if (req.url === '/page') return send('text/html', '<html>not an image</html>');
    if (req.url === '/doc.pdf') return send('application/pdf', '%PDF-1.4');
    if (req.url === '/big') return send('image/png', Buffer.alloc(2048));
    if (req.url === '/missing') return void res.writeHead(404).end();
    // Like Wikimedia: generic clients (Bun's default User-Agent) get 429.
    if (req.url === '/strict.png') return /karpathy\.app/.test(req.headers['user-agent'] ?? '') ? send('image/png', PNG) : void res.writeHead(429).end();
    if (req.url === '/to-cat') return void res.writeHead(302, { location: '/cat.png' }).end();
    if (req.url === '/to-localhost') return void res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/cat.png` }).end();
    const hop = /^\/hop(\d+)$/.exec(req.url ?? '');
    if (hop) return void res.writeHead(302, { location: `/hop${Number(hop[1]) + 1}` }).end();
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe('saveUrl', () => {
  it('saves an image into the vault and returns the path and the embed', async () => {
    const out = await saveUrl(vault, `${origin}/cat.png`, 'notes/cat.png');
    expect(out).toContain('saved notes/cat.png');
    expect(out).toContain('![[notes/cat.png]]');
    expect(await readFile(join(vault, 'notes/cat.png'))).toEqual(PNG);
  });

  it('creates missing folders and accepts an absolute path inside the vault', async () => {
    await saveUrl(vault, `${origin}/doc.pdf`, join(vault, 'Sources/papers/doc.pdf'));
    expect(await readFile(join(vault, 'Sources/papers/doc.pdf'), 'utf8')).toBe('%PDF-1.4');
  });

  it('accepts application/octet-stream (CDNs send it for images)', async () => {
    await saveUrl(vault, `${origin}/blob`, 'notes/blob.png');
    expect(await readFile(join(vault, 'notes/blob.png'))).toEqual(PNG);
  });

  it('never overwrites a file', async () => {
    await expect(saveUrl(vault, `${origin}/cat.png`, 'notes/taken.png')).rejects.toThrow('already exists: notes/taken.png');
    expect(await readFile(join(vault, 'notes/taken.png'), 'utf8')).toBe('old');
  });

  it('refuses a web page saved as an image', async () => {
    await expect(saveUrl(vault, `${origin}/page`, 'notes/page.png')).rejects.toThrow('not a png file: the server sent text/html');
    await expect(readFile(join(vault, 'notes/page.png'))).rejects.toThrow();
  });

  it('refuses a failed download', async () => {
    await expect(saveUrl(vault, `${origin}/missing`, 'notes/missing.png')).rejects.toThrow('download failed: HTTP 404');
  });

  it('refuses a file over the size cap and leaves nothing behind', async () => {
    await expect(saveUrl(vault, `${origin}/big`, 'notes/big.png', { maxBytes: 1024 })).rejects.toThrow('larger than 1 KB');
    await expect(readFile(join(vault, 'notes/big.png'))).rejects.toThrow();
  });

  it('refuses types that are not media or PDF, SVG and notes included', async () => {
    for (const p of ['notes/x.md', 'notes/x.svg', 'notes/x.html', 'notes/x.zip', 'notes/noext'])
      await expect(saveUrl(vault, `${origin}/cat.png`, p)).rejects.toThrow('only images, videos, audio and PDFs');
  });

  it('refuses paths outside the vault, through a symlink too', async () => {
    await expect(saveUrl(vault, `${origin}/cat.png`, '../other/x.png')).rejects.toThrow('outside the vault');
    await expect(saveUrl(vault, `${origin}/cat.png`, '/tmp/x.png')).rejects.toThrow('outside the vault');
    await expect(saveUrl(vault, `${origin}/cat.png`, 'escape/x.png')).rejects.toThrow('outside the vault');
  });

  it('refuses dot-paths (.git, .opencode, hidden files)', async () => {
    for (const p of ['.git/x.png', '.opencode/x.png', 'notes/.x.png'])
      await expect(saveUrl(vault, `${origin}/cat.png`, p)).rejects.toThrow('hidden path');
  });

  it('sends a descriptive User-Agent (Wikimedia refuses generic ones)', async () => {
    await saveUrl(vault, `${origin}/strict.png`, 'notes/strict.png');
    expect(await readFile(join(vault, 'notes/strict.png'))).toEqual(PNG);
  });

  it('follows a redirect', async () => {
    await saveUrl(vault, `${origin}/to-cat`, 'notes/redirected.png');
    expect(await readFile(join(vault, 'notes/redirected.png'))).toEqual(PNG);
  });

  it('refuses NO_PROXY hosts (Bun fetches them without the proxy), on a redirect hop too, and writes nothing', async () => {
    const env = { NO_PROXY: 'localhost,127.0.0.1,0.0.0.0' }; // compose's value
    await expect(saveUrl(vault, `${origin}/to-localhost`, 'notes/hop.png', { env: { NO_PROXY: 'localhost' } })).rejects.toThrow('internal host refused: localhost');
    await expect(readFile(join(vault, 'notes/hop.png'))).rejects.toThrow();
    for (const u of ['http://localhost/x.png', 'http://LOCALHOST/x.png', 'http://localhost./x.png', 'http://foo.localhost/x.png', 'http://127.1/x.png', 'http://0/x.png', 'http://2130706433/x.png'])
      await expect(saveUrl(vault, u, 'notes/h.png', { env })).rejects.toThrow('internal host refused');
  });

  it('refuses NO_PROXY hosts, subdomains included', async () => {
    await expect(saveUrl(vault, 'https://cdn.example.com/x.png', 'notes/n.png', { env: { NO_PROXY: 'localhost,.example.com:443' } })).rejects.toThrow('internal host refused: cdn.example.com');
    await expect(saveUrl(vault, 'https://example.org/x.png', 'notes/n.png', { env: { no_proxy: '*' } })).rejects.toThrow('internal host refused: example.org');
  });

  it('stops after 5 redirects', async () => {
    await expect(saveUrl(vault, `${origin}/hop0`, 'notes/loop.png')).rejects.toThrow('too many redirects');
  });

  it('refuses non-http(s) URLs', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x.png', 'not a url'])
      await expect(saveUrl(vault, u, 'notes/u.png')).rejects.toThrow('Only http(s) URLs');
  });
});

describe('proxyFor', () => {
  it('takes the proxy for the scheme, upper or lower case, and ignores NO_PROXY', () => {
    expect(proxyFor('https://a.example/x', { HTTPS_PROXY: 'http://egress:3128', NO_PROXY: 'a.example' })).toBe('http://egress:3128');
    expect(proxyFor('http://a.example/x', { http_proxy: 'http://egress:3128' })).toBe('http://egress:3128');
  });

  it('is undefined without a proxy (the tool then refuses)', () => {
    expect(proxyFor('https://a.example/x', { HTTP_PROXY: 'http://egress:3128' })).toBeUndefined();
  });
});

describe('SAVE_TYPES', () => {
  it('is the media table without SVG, plus PDF', () => {
    expect([...SAVE_TYPES].sort()).toEqual([...Object.keys(MEDIA).filter((e) => e !== 'svg'), 'pdf'].sort());
  });
});
