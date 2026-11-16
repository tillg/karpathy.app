import type { Server } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { Terminals } from '../src/terminals.js';

const TOKEN = 'terminal-test-token';
let server: Server;
let terms: Terminals;
let base: string;
let vaults: string;

beforeEach(async () => {
  vaults = await mkdtemp(join(tmpdir(), 'vaults-'));
  await mkdir(join(vaults, 'demo', 'Wiki'), { recursive: true });
  terms = new Terminals({ shell: '/bin/sh' });
  server = await startServer({ terminals: terms, token: TOKEN, vaultsDir: vaults, port: 0 });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(() => {
  terms.closeAll();
  server.close();
});

const call = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });

/** Reads NDJSON items from a stream until `done` says stop. */
async function readUntil(res: Response, done: (text: string) => boolean) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const end = Date.now() + 5000;
  while (!done(text) && Date.now() < end) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.t === 'o') text += e.d;
    }
  }
  await reader.cancel();
  return text;
}

describe('terminal server', () => {
  it('refuses a request without the token', async () => {
    expect((await call('/terminals', {}, 'wrong')).status).toBe(401);
    expect((await fetch(base + '/terminals')).status).toBe(401);
  });

  it('answers its health check without the token', async () => {
    expect((await fetch(base + '/healthz')).status).toBe(200);
  });

  it('opens a session in a folder under the vaults dir and runs input', async () => {
    const r = await call('/terminals', { method: 'POST', body: JSON.stringify({ cwd: 'demo/Wiki', cols: 80, rows: 24 }) });
    expect(r.status).toBe(201);
    const { id, cwd } = await r.json();
    expect(cwd).toBe('demo/Wiki');
    const stream = await call(`/terminals/${id}/stream`);
    expect(stream.headers.get('content-type')).toMatch(/ndjson/);
    expect((await call(`/terminals/${id}/input`, { method: 'POST', body: JSON.stringify({ data: 'pwd\r' }) })).status).toBe(204);
    const text = await readUntil(stream, (t) => t.includes('/demo/Wiki\r\n'));
    expect(text).toContain('/demo/Wiki');
    expect((await (await call('/terminals')).json()).terminals.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it('refuses a folder outside the vaults dir or one that does not exist', async () => {
    for (const cwd of ['../', 'demo/../..', '/etc', 'nope']) {
      const r = await call('/terminals', { method: 'POST', body: JSON.stringify({ cwd, cols: 80, rows: 24 }) });
      expect(r.status, cwd).toBe(400);
    }
  });

  it('resizes and closes a session; unknown ids are 404', async () => {
    const { id } = await (await call('/terminals', { method: 'POST', body: JSON.stringify({ cwd: '', cols: 80, rows: 24 }) })).json();
    expect((await call(`/terminals/${id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 120, rows: 40 }) })).status).toBe(204);
    expect((await call(`/terminals/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/terminals/${id}/stream`)).status).toBe(404);
    expect((await call(`/terminals/${id}/input`, { method: 'POST', body: JSON.stringify({ data: 'x' }) })).status).toBe(404);
  });

  it('answers 429 past the session limit', async () => {
    terms.closeAll();
    server.close();
    terms = new Terminals({ shell: '/bin/sh', max: 1 });
    server = await startServer({ terminals: terms, token: TOKEN, vaultsDir: vaults, port: 0 });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const open = () => call('/terminals', { method: 'POST', body: JSON.stringify({ cwd: '', cols: 80, rows: 24 }) });
    expect((await open()).status).toBe(201);
    const r = await open();
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatch(/at most 1/);
  });
});
