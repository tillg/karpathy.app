import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError, type Vaults } from './vaults.js';
import { relative } from 'node:path';

/**
 * The app's terminal (#175): the shells run in the terminal service (apps/terminal, its own container without app
 * secrets); these routes check the user's bearer token and forward with the terminal token. Off (no endpoint) = 404.
 */
export interface TerminalEndpoint {
  url: string;
  token: string;
}

const size = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };
const openBody = z.object(size).strict();
const terminalId = z.uuid({ error: 'not a terminal id' });

const off = () => new HttpError(404, 'The terminal is off on this server', 'terminal-off');
const down = () => new HttpError(503, 'Terminal service not running', 'terminal-down');

async function call(ep: TerminalEndpoint, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<globalThis.Response> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${ep.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ep.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw down();
  }
  if (res.ok) return res;
  // A token mismatch is a deploy problem, never the user's login (a 401 would log the app out).
  if (res.status === 401) throw new HttpError(502, 'The terminal service refused the backend (terminal token mismatch)', 'terminal-auth');
  const out = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw new HttpError(res.status, typeof out.error === 'string' ? out.error : `Terminal service: ${res.status}`, res.status === 429 ? 'terminal-limit' : 'terminal-error');
}

/** Routes under /api (bearer-guarded by the caller). */
export function terminalRouter(ep: TerminalEndpoint | undefined, vaults: Vaults) {
  const r = Router();
  const need = () => {
    if (!ep) throw off();
    return ep;
  };
  const tid = (req: Request) => terminalId.parse(req.params.tid);
  const pass = async (res: Response, up: globalThis.Response) => {
    if (up.status === 204) return void res.status(204).end();
    res.status(up.status).json(await up.json());
  };

  r.get('/terminals', async (_req, res) => pass(res, await call(need(), 'GET', '/terminals')));
  r.post('/vaults/:id/terminals', async (req, res) => {
    const e = need();
    const b = openBody.parse(req.body ?? {});
    const v = vaults.getVault(req.params.id!);
    if (v.state === 'cloning' || v.state === 'clone-failed') throw new HttpError(409, 'The vault is not cloned yet', 'not-ready');
    const cwd = relative(vaults.vaultsPath(), vaults.vaultRootDir(v.id));
    await pass(res, await call(e, 'POST', '/terminals', { cwd, ...b }));
  });
  r.get('/terminals/:tid/stream', async (req, res) => {
    const e = need();
    const id = tid(req);
    const from = typeof req.query.from === 'string' && /^\d+$/.test(req.query.from) ? `?from=${req.query.from}` : '';
    const ctrl = new AbortController();
    const up = await call(e, 'GET', `/terminals/${id}/stream${from}`, undefined, ctrl.signal);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const body = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream);
    body.on('error', () => res.end());
    // pipe() carries backpressure: a slow browser pauses the upstream read, and so the shell.
    body.pipe(res);
    res.on('close', () => ctrl.abort());
  });
  r.post('/terminals/:tid/input', async (req, res) => pass(res, await call(need(), 'POST', `/terminals/${tid(req)}/input`, req.body)));
  r.post('/terminals/:tid/resize', async (req, res) => pass(res, await call(need(), 'POST', `/terminals/${tid(req)}/resize`, req.body)));
  r.delete('/terminals/:tid', async (req, res) => pass(res, await call(need(), 'DELETE', `/terminals/${tid(req)}`)));
  return r;
}
