import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { TerminalLimitError, TerminalNotFound, type Terminals } from './terminals.js';

/**
 * The terminal service's HTTP API (#175), reached only by the backend over the internal network with the terminal
 * token. Routes: list, open (`cwd` relative to the vaults dir), NDJSON stream, input, resize, close.
 */
export interface ServerOptions {
  terminals: Terminals;
  token: string;
  vaultsDir: string;
  port: number;
  host?: string;
}

const size = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };
const openBody = z.object({ cwd: z.string().max(1000), ...size }).strict();
const resizeBody = z.object(size).strict();
const inputBody = z.object({ data: z.string().max(1_000_000) }).strict();

class BadRequest extends Error {}

/** `cwd` as a folder inside the vaults dir (after resolving symlinks), or BadRequest. */
function resolveCwd(vaultsDir: string, cwd: string): string {
  if (isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new BadRequest('cwd must be a folder inside the vaults');
  const root = realpathSync(vaultsDir);
  let abs: string;
  try {
    abs = realpathSync(join(root, cwd));
  } catch {
    throw new BadRequest(`no folder ${cwd}`);
  }
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new BadRequest('cwd must be a folder inside the vaults');
  if (!statSync(abs).isDirectory()) throw new BadRequest(`${cwd} is not a folder`);
  return abs;
}

export function createServerApp({ terminals, token, vaultsDir }: Omit<ServerOptions, 'port' | 'host'>) {
  if (!token) throw new Error('terminal token must be set');
  const want = createHash('sha256').update(token).digest();
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => void res.send('ok'));
  app.use((req, res, next) => {
    const h = req.headers.authorization ?? '';
    const got = createHash('sha256').update(h.startsWith('Bearer ') ? h.slice(7) : '').digest();
    if (h.startsWith('Bearer ') && timingSafeEqual(got, want)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/terminals', (_req, res) => void res.json({ terminals: terminals.list() }));
  app.post('/terminals', (req, res) => {
    const b = openBody.parse(req.body);
    const abs = resolveCwd(vaultsDir, b.cwd);
    res.status(201).json(terminals.open(abs, b.cols, b.rows, b.cwd));
  });
  app.get('/terminals/:id/stream', (req, res) => {
    const id = req.params.id!;
    if (!terminals.has(id)) throw new TerminalNotFound(id);
    const from = typeof req.query.from === 'string' && /^\d+$/.test(req.query.from) ? Number(req.query.from) : undefined;
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const keepalive = setInterval(() => res.write('\n'), 15_000);
    const detach = terminals.attach(id, from, {
      send: (e) => res.write(`${JSON.stringify(e)}\n`),
      onDrain: (fn) => res.on('drain', fn),
      end: () => res.end(),
    });
    res.on('close', () => {
      clearInterval(keepalive);
      detach();
    });
  });
  app.post('/terminals/:id/input', (req, res) => {
    terminals.input(req.params.id!, inputBody.parse(req.body).data);
    res.status(204).end();
  });
  app.post('/terminals/:id/resize', (req, res) => {
    const b = resizeBody.parse(req.body);
    terminals.resize(req.params.id!, b.cols, b.rows);
    res.status(204).end();
  });
  app.delete('/terminals/:id', (req, res) => {
    terminals.close(req.params.id!);
    res.status(204).end();
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof TerminalNotFound) return void res.status(404).json({ error: err.message });
    if (err instanceof TerminalLimitError) return void res.status(429).json({ error: err.message });
    if (err instanceof BadRequest) return void res.status(400).json({ error: err.message });
    if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}

export function startServer(o: ServerOptions): Promise<Server> {
  const app = createServerApp(o);
  return new Promise((resolve) => {
    const server = o.host === undefined ? app.listen(o.port, () => resolve(server)) : app.listen(o.port, o.host, () => resolve(server));
  });
}
