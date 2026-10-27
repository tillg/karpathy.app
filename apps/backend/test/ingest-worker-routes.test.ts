import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, TOKEN } from './app-helpers.js';

// The Instagram worker's job routes (#168): the backend checks the worker token (or the main one) and forwards to the
// ingest service's endpoint (deploy/ingest/server.py), the result upload streamed. A real local HTTP server stands in
// for the ingest service; the routes, auth and streaming are the real ones.

const INGEST_TOKEN = 'ingest-secret';
const WORKER_TOKEN = 'worker-secret-456';
const JOB = { id: 'C9abcDEF12x', url: 'https://www.instagram.com/p/C9abcDEF12x/', leaseUntil: '2026-10-27T12:30:00Z' };

interface Seen { method: string; path: string; auth: string | undefined; length: string | undefined; bytes: number; sha256: string; body: string }
let seen: Seen[] = [];
/** What the next claim answers: a job, none (204) or local mode (409). */
let claim: 'job' | 'none' | 'local' = 'job';
/** Resolved by the fake when the first chunk of an upload arrives. */
let firstChunk: () => void = () => {};
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, obj?: object) =>
      obj ? res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj)) : res.writeHead(status).end();
    const hash = createHash('sha256');
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (bytes === 0) firstChunk();
      bytes += c.length;
      hash.update(c);
      if (bytes < 100_000) chunks.push(c);
    });
    req.on('end', () => {
      const path = req.url!;
      seen.push({ method: req.method!, path, auth: req.headers.authorization, length: req.headers['content-length'], bytes, sha256: hash.digest('hex'), body: Buffer.concat(chunks).toString() });
      if (req.headers.authorization !== `Bearer ${INGEST_TOKEN}`) return send(401, { error: 'unauthorized' });
      if (req.method === 'POST' && path === '/instagram/jobs/claim')
        return claim === 'job' ? send(200, JOB) : claim === 'none' ? send(204) : send(409, { error: 'not-worker-mode' });
      if (req.method === 'POST' && /^\/instagram\/jobs\/[^/]+\/(failure|release)$/.test(path)) return send(204);
      if (req.method === 'POST' && path === '/instagram/worker/heartbeat') return send(204);
      if (req.method === 'PUT' && path === '/instagram/jobs/TooBig123/result') return send(413, { error: 'too-large', message: 'The result is larger than 500 MB' });
      if (req.method === 'PUT' && path === '/instagram/jobs/Invalid12/result') return send(422, { error: 'invalid-result', message: 'metadata.json: shortcode differs from the job' });
      if (req.method === 'PUT' && /^\/instagram\/jobs\/[^/]+\/result$/.test(path)) return send(204);
      send(404, { error: 'not-found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());
beforeEach(() => {
  seen = [];
  claim = 'job';
});

const app = async (deps: object = { ingest: { url, token: INGEST_TOKEN }, workerToken: WORKER_TOKEN }) => (await makeApp('file:///nowhere/', { deps })).app;
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('ingest worker routes', () => {
  it('the worker token claims a job (200 body passed through)', async () => {
    const r = await request(await app()).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(JOB);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /instagram/jobs/claim']);
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: 'mac' });
  });

  it('204 and 409 pass through', async () => {
    const a = await app();
    claim = 'none';
    const none = await request(a).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    expect(none.status).toBe(204);
    expect(none.text).toBe('');
    claim = 'local';
    const local = await request(a).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    expect(local.status).toBe(409);
    expect(local.body).toEqual({ error: 'not-worker-mode' });
    for (const [path, body] of [
      [`/jobs/${JOB.id}/failure`, { reason: 'ValueError: x', permanent: false }],
      [`/jobs/${JOB.id}/release`, undefined],
      ['/worker/heartbeat', { name: 'mac', version: '0.1.0', state: 'idle' }],
    ] as const) {
      const r = await request(a).post(`/api/ingest/instagram${path}`).set(as(WORKER_TOKEN)).send(body);
      expect(r.status, path).toBe(204);
    }
    expect(seen.slice(2).map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /instagram/jobs/${JOB.id}/failure`, `POST /instagram/jobs/${JOB.id}/release`, 'POST /instagram/worker/heartbeat',
    ]);
    expect(JSON.parse(seen[2]!.body)).toEqual({ reason: 'ValueError: x', permanent: false });
  });

  it('the main token works on the worker routes', async () => {
    const r = await request(await app()).post('/api/ingest/instagram/jobs/claim').set(as(TOKEN)).send({ name: 'mac' });
    expect(r.status).toBe(200);
  });

  it('the worker token gets 401 on /api/vaults, /api/ingest/instagram, /api/ingest/instagram/login and /api/settings/secrets', async () => {
    const a = await app();
    expect((await request(a).get('/api/vaults').set(as(WORKER_TOKEN))).status).toBe(401);
    expect((await request(a).get('/api/ingest/instagram').set(as(WORKER_TOKEN))).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/login').set(as(WORKER_TOKEN)).send({ username: 'a', password: 'b' })).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/disconnect').set(as(WORKER_TOKEN))).status).toBe(401);
    expect((await request(a).get('/api/settings/secrets').set(as(WORKER_TOKEN))).status).toBe(401);
    // Only the exact routes: another method, a trailing slash or other case falls through to the main token.
    expect((await request(a).get('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN))).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/jobs/claim/').set(as(WORKER_TOKEN)).send({})).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/JOBS/claim').set(as(WORKER_TOKEN)).send({})).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('no token or a wrong one is 401 on the worker routes', async () => {
    const a = await app();
    expect((await request(a).post('/api/ingest/instagram/jobs/claim').send({ name: 'mac' })).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/worker/heartbeat').set(as('nope')).send({ name: 'mac' })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('without a configured worker token only the main token works', async () => {
    const a = await app({ ingest: { url, token: INGEST_TOKEN } });
    expect((await request(a).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' })).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/jobs/claim').set(as('')).send({ name: 'mac' })).status).toBe(401);
    expect((await request(a).post('/api/ingest/instagram/jobs/claim').set(as(TOKEN)).send({ name: 'mac' })).status).toBe(200);
  });

  it('the ingest service gets the ingest token, never the worker token', async () => {
    const a = await app();
    await request(a).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    await request(a).post('/api/ingest/instagram/worker/heartbeat').set(as(WORKER_TOKEN)).send({ name: 'mac', version: '1', state: 'idle' });
    await request(a).put(`/api/ingest/instagram/jobs/${JOB.id}/result`).set(as(WORKER_TOKEN)).set('Content-Type', 'application/gzip').send(Buffer.from('tgz'));
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s.auth === `Bearer ${INGEST_TOKEN}`)).toBe(true);
  });

  it('a bad job id is 400 before anything is forwarded', async () => {
    const a = await app();
    for (const id of ['abc', '..%2Flogin%3F', 'a%20bcdef', 'x'.repeat(41)]) {
      expect((await request(a).post(`/api/ingest/instagram/jobs/${id}/release`).set(as(WORKER_TOKEN))).status, id).toBe(400);
      expect((await request(a).put(`/api/ingest/instagram/jobs/${id}/result`).set(as(WORKER_TOKEN)).send(Buffer.from('x'))).status, id).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it('a 20 kB heartbeat is 413', async () => {
    const a = await app();
    const r = await request(a).post('/api/ingest/instagram/worker/heartbeat').set(as(WORKER_TOKEN)).send({ name: 'mac', message: 'x'.repeat(20_000) });
    expect(r.status).toBe(413);
    // The ingest service's own limit is 10 kB: the backend refuses what it would refuse.
    expect((await request(a).post('/api/ingest/instagram/worker/heartbeat').set(as(WORKER_TOKEN)).send({ name: 'mac', message: 'x'.repeat(11_000) })).status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('ingest down → 503 ingest-down', async () => {
    const down = await app({ ingest: { url: 'http://127.0.0.1:1', token: INGEST_TOKEN }, workerToken: WORKER_TOKEN });
    const r = await request(down).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'ingest-down' });
    const up = await request(down).put(`/api/ingest/instagram/jobs/${JOB.id}/result`).set(as(WORKER_TOKEN)).send(Buffer.from('x'));
    expect(up.status).toBe(503);
    const none = await app({ workerToken: WORKER_TOKEN });
    expect((await request(none).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' })).status).toBe(503);
  });

  it('an ingest-side 401 is a 502, never a 401', async () => {
    const a = await app({ ingest: { url, token: 'not-the-ingest-token' }, workerToken: WORKER_TOKEN });
    const r = await request(a).post('/api/ingest/instagram/jobs/claim').set(as(WORKER_TOKEN)).send({ name: 'mac' });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: 'ingest-auth' });
  });
});

/** The backend on a real port, so a test controls when each chunk of an upload is sent. */
async function listen(deps?: object) {
  const s = (await app(deps)).listen(0, '127.0.0.1');
  await new Promise<void>((r) => s.once('listening', r));
  return { port: (s.address() as AddressInfo).port, close: () => s.close() };
}

/** A PUT whose body the caller writes; resolves with the backend's answer. */
function put(port: number, path: string, headers: Record<string, string | number>) {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'PUT', headers });
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (res: IncomingMessage) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
  });
  return { req, answer };
}

describe('ingest worker result upload', () => {
  it('a 60 MB body arrives byte-identical with its Content-Length', async () => {
    const { port, close } = await listen();
    try {
      const body = randomBytes(60 * 1024 * 1024);
      const { req, answer } = put(port, `/api/ingest/instagram/jobs/${JOB.id}/result`, { ...as(WORKER_TOKEN), 'Content-Type': 'application/gzip', 'Content-Length': body.length });
      req.end(body);
      expect((await answer).status).toBe(204);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'PUT', path: `/instagram/jobs/${JOB.id}/result`, length: String(body.length), bytes: body.length });
      expect(seen[0]!.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    } finally {
      close();
    }
  }, 60_000);

  it('the fake ingest service sees the first chunk before the client has sent the last (streamed, not buffered)', async () => {
    const { port, close } = await listen();
    try {
      const chunk = randomBytes(256 * 1024);
      const arrived = new Promise<boolean>((resolve) => {
        firstChunk = () => resolve(true);
        setTimeout(() => resolve(false), 5000).unref();
      });
      const { req, answer } = put(port, `/api/ingest/instagram/jobs/${JOB.id}/result`, { ...as(WORKER_TOKEN), 'Content-Length': chunk.length * 2 });
      req.write(chunk);
      const streamed = await arrived;
      req.end(chunk);
      expect((await answer).status).toBe(204);
      expect(streamed).toBe(true);
      expect(seen[0]!.bytes).toBe(chunk.length * 2);
    } finally {
      firstChunk = () => {};
      close();
    }
  }, 20_000);

  it('no Content-Length → 411 and nothing reaches the ingest service', async () => {
    const { port, close } = await listen();
    try {
      const { req, answer } = put(port, `/api/ingest/instagram/jobs/${JOB.id}/result`, { ...as(WORKER_TOKEN), 'Transfer-Encoding': 'chunked' });
      req.write('part');
      req.end('rest');
      const r = await answer;
      expect(r.status).toBe(411);
      expect(JSON.parse(r.body)).toMatchObject({ code: 'length-required' });
      expect(seen).toEqual([]);
    } finally {
      close();
    }
  });

  it('413 and 422 with their messages pass through', async () => {
    const a = await app();
    const big = await request(a).put('/api/ingest/instagram/jobs/TooBig123/result').set(as(WORKER_TOKEN)).send(Buffer.alloc(1024));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'too-large', message: 'The result is larger than 500 MB' });
    const bad = await request(a).put('/api/ingest/instagram/jobs/Invalid12/result').set(as(WORKER_TOKEN)).send(Buffer.alloc(1024));
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: 'invalid-result', message: 'metadata.json: shortcode differs from the job' });
  });

  it('the worker token is accepted, a wrong one is 401 before any byte is forwarded', async () => {
    const { port, close } = await listen();
    try {
      let forwarded = false;
      firstChunk = () => (forwarded = true);
      const wrong = put(port, `/api/ingest/instagram/jobs/${JOB.id}/result`, { ...as('wrong-token'), 'Content-Length': 4 });
      wrong.req.end('abcd');
      expect((await wrong.answer).status).toBe(401);
      expect(forwarded).toBe(false);
      expect(seen).toEqual([]);
      const right = put(port, `/api/ingest/instagram/jobs/${JOB.id}/result`, { ...as(WORKER_TOKEN), 'Content-Length': 4 });
      right.req.end('abcd');
      expect((await right.answer).status).toBe(204);
      expect(seen[0]).toMatchObject({ bytes: 4, body: 'abcd' });
    } finally {
      firstChunk = () => {};
      close();
    }
  });
});
