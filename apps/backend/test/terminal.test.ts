import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The real terminal service (apps/terminal), in-process: the backend's routes forward to it.
import { startServer } from '../../terminal/src/server.js';
import { Terminals } from '../../terminal/src/terminals.js';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const listen = async (server: http.Server) => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** A backend whose terminal routes go to a real terminal service sharing its vaults dir. */
async function setup({ terminal = true, root = '' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'kai-term-'));
  const dirs = { config: join(base, 'config'), vaults: join(base, 'vaults') };
  await mkdir(dirs.vaults, { recursive: true });
  const terms = new Terminals({ shell: '/bin/sh', max: 2 });
  const termServer = await startServer({ terminals: terms, token: 'internal-terminal-token', vaultsDir: dirs.vaults, port: 0, host: '127.0.0.1' });
  cleanups.push(() => { terms.closeAll(); termServer.close(); });
  const remote = await makeRemote({ 'notes/Wiki/Home.md': '# Home\n', 'notes/Sources/.gitkeep': '', 'notes/a.md': 'a' });
  const t = await makeApp(remote.remoteBase, { dirs, deps: terminal ? { terminal: { url: await listen(termServer), token: 'internal-terminal-token' } } : {} });
  cleanups.push(() => t.vaults.close());
  const id = await t.addVault(remote.repo, root ? { root } : {});
  const server = http.createServer(t.app).listen(0);
  cleanups.push(() => void server.close());
  const base_ = await listen(server);
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base_}/api${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...init.headers } });
  return { ...t, id, call, terms };
}

/** Collects a stream's output text until `done` holds (or 5 s). */
async function read(res: Response, done: (text: string) => boolean) {
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
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && JSON.parse(line).t === 'o') text += JSON.parse(line).d;
    }
  }
  await reader.cancel();
  return text;
}

describe('terminal routes', () => {
  it('opens a shell in the vault folder, streams it and takes input', async () => {
    const t = await setup({ root: 'notes' });
    const r = await t.call(`/vaults/${t.id}/terminals`, { method: 'POST', body: JSON.stringify({ cols: 90, rows: 20 }) });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
    const { id } = await r.json();
    const stream = await t.call(`/terminals/${id}/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/ndjson/);
    expect((await t.call(`/terminals/${id}/input`, { method: 'POST', body: JSON.stringify({ data: 'pwd; ls; echo "x$((6*7))"\r' }) })).status).toBe(204);
    const text = await read(stream, (s) => s.includes('x42'));
    expect(text).toContain(`/${t.id}/notes\r\n`);
    expect(text).toContain('a.md');
    expect((await (await t.call('/terminals')).json()).terminals).toHaveLength(1);
    expect((await t.call(`/terminals/${id}/resize`, { method: 'POST', body: JSON.stringify({ cols: 100, rows: 30 }) })).status).toBe(204);
    expect((await t.call(`/terminals/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await (await t.call('/terminals')).json()).terminals).toHaveLength(0);
  });

  it('passes the service limit and unknown ids through as errors', async () => {
    const t = await setup();
    const open = () => t.call(`/vaults/${t.id}/terminals`, { method: 'POST', body: JSON.stringify({ cols: 80, rows: 24 }) });
    expect((await open()).status).toBe(201);
    expect((await open()).status).toBe(201);
    const third = await open();
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/at most 2 terminals/);
    const missing = await t.call('/terminals/00000000-0000-4000-8000-000000000000/stream');
    expect(missing.status).toBe(404);
    expect((await t.call('/terminals/not-an-id/stream')).status).toBe(400);
  });

  it('needs the bearer token', async () => {
    const t = await setup();
    expect((await t.call('/terminals', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('is 404 when the terminal is off, and the settings say so', async () => {
    const t = await setup({ terminal: false });
    const r = await t.call(`/vaults/${t.id}/terminals`, { method: 'POST', body: JSON.stringify({ cols: 80, rows: 24 }) });
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('terminal-off');
    expect((await (await t.call('/settings')).json()).terminal).toBe(false);
  });

  it('the settings tell the app the terminal is on', async () => {
    const t = await setup();
    expect((await (await t.call('/settings')).json()).terminal).toBe(true);
  });

  it('a clone whose .git/config the terminal made unsafe is refused with a 409 that names the key', async () => {
    const t = await setup();
    await appendFile(join(t.dirs.vaults, t.id, '.git', 'config'), '[filter "x"]\n\tclean = touch /tmp/pwned\n');
    const r = await t.call(`/vaults/${t.id}/status`);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe('unsafe-git-config');
    expect(body.error).toContain('filter.x.clean');
  });

  it('reports the terminal service being down as 503, not as a logout', async () => {
    const t = await setup();
    t.terms.closeAll();
    const remote = await makeRemote({ 'a.md': 'a' });
    const down = await makeApp(remote.remoteBase, { deps: { terminal: { url: 'http://127.0.0.1:9', token: 'x' } } });
    cleanups.push(() => down.vaults.close());
    const r = await down.api.get('/terminals');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('terminal-down');
  });
});
