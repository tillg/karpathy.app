import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp, TOKEN } from './app-helpers.js';

// The backend's Admin › Instagram routes, proxied to the ingest service's endpoint (deploy/ingest/server.py). A real
// local HTTP server stands in for the ingest service; the routes, auth and validation are the real ones.

const INGEST_TOKEN = 'ingest-secret';
const PASSWORD = 'very-secret-pw';
let server: Server;
let url: string;
const seen: { method: string; path: string; auth: string | undefined; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
      const send = (status: number, obj: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (req.headers.authorization !== `Bearer ${INGEST_TOKEN}`) return send(401, { error: 'unauthorized' });
      if (req.url === '/instagram/status') return send(200, { state: 'connected', account: 'tillg', waitingLinks: 2 });
      if (req.url === '/instagram/login') {
        const b = JSON.parse(body);
        if (b.password === 'wrong') return send(400, { error: 'wrong-password', message: 'Wrong username or password' });
        return send(200, { state: 'code', via: 'SMS' });
      }
      if (req.url === '/instagram/code') return send(200, { state: 'connected', account: 'tillg' });
      if (req.url === '/instagram/disconnect') return send(200, { state: 'not-connected', waitingLinks: 0 });
      send(404, { error: 'not-found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe('ingest routes', () => {
  it('need the bearer token', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
    expect((await request(t.app).get('/api/ingest/instagram')).status).toBe(401);
    expect((await request(t.app).post('/api/ingest/instagram/login').send({ username: 'a', password: 'b' })).status).toBe(401);
  });

  it('forward to the ingest service with its token and pass the answer on', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
    seen.length = 0;
    expect((await t.api.get('/ingest/instagram')).body).toEqual({ state: 'connected', account: 'tillg', waitingLinks: 2 });
    expect((await t.api.post('/ingest/instagram/login', { username: 'tillg', password: PASSWORD })).body).toEqual({ state: 'code', via: 'SMS' });
    expect((await t.api.post('/ingest/instagram/code', { code: '123456' })).body).toEqual({ state: 'connected', account: 'tillg' });
    expect((await t.api.post('/ingest/instagram/disconnect')).body).toEqual({ state: 'not-connected', waitingLinks: 0 });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /instagram/status', 'POST /instagram/login', 'POST /instagram/code', 'POST /instagram/disconnect',
    ]);
    expect(seen.every((s) => s.auth === `Bearer ${INGEST_TOKEN}`)).toBe(true);
    expect(JSON.parse(seen[1]!.body)).toEqual({ username: 'tillg', password: PASSWORD });
    expect(seen.some((s) => s.auth?.includes(TOKEN))).toBe(false);
  });

  it('errors of the ingest service keep their status, as { error, code }', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
    const r = await t.api.post('/ingest/instagram/login', { username: 'tillg', password: 'wrong' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Wrong username or password', code: 'wrong-password' });
  });

  it('an ingest-side 401 is a 502, never a 401 (which would log the user out of the app)', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: 'not-the-ingest-token' } } });
    const r = await t.api.get('/ingest/instagram');
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'ingest-auth' });
  });

  it('usernames are Instagram usernames: no paths, no spaces', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
    seen.length = 0;
    for (const username of ['../../vaults/x/Input', 'a/b', 'a b', '..', 'x'.repeat(31)])
      expect((await t.api.post('/ingest/instagram/login', { username, password: 'p' })).status, username).toBe(400);
    expect(seen).toEqual([]);
    expect((await t.api.post('/ingest/instagram/login', { username: '@till.g_1', password: 'p' })).status).toBe(200);
    expect(JSON.parse(seen[0]!.body).username).toBe('till.g_1');
  });

  it('validates bodies', async () => {
    const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
    seen.length = 0;
    expect((await t.api.post('/ingest/instagram/login', { username: 'tillg' })).status).toBe(400);
    expect((await t.api.post('/ingest/instagram/login', { username: '', password: 'x' })).status).toBe(400);
    expect((await t.api.post('/ingest/instagram/code', {})).status).toBe(400);
    expect((await t.api.post('/ingest/instagram/code', { code: 'x'.repeat(100) })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('503 "Ingest service not running" when it is down or not configured', async () => {
    const down = await makeApp('file:///nowhere/', { deps: { ingest: { url: 'http://127.0.0.1:1', token: INGEST_TOKEN } } });
    const r = await down.api.get('/ingest/instagram');
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: 'Ingest service not running', code: 'ingest-down' });
    const none = await makeApp('file:///nowhere/');
    expect((await none.api.post('/ingest/instagram/login', { username: 'a', password: 'b' })).status).toBe(503);
  });

  it('the password never appears in the backend log', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a.join(' '))));
    try {
      const t = await makeApp('file:///nowhere/', { deps: { ingest: { url, token: INGEST_TOKEN } } });
      await t.api.post('/ingest/instagram/login', { username: 'tillg', password: PASSWORD });
      await t.api.post('/ingest/instagram/login', { username: 'tillg', password: PASSWORD, extra: 1 });
      const down = await makeApp('file:///nowhere/', { deps: { ingest: { url: 'http://127.0.0.1:1', token: INGEST_TOKEN } } });
      await down.api.post('/ingest/instagram/login', { username: 'tillg', password: PASSWORD });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });
});
