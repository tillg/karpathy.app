import express, { type NextFunction, type Request, type Response } from 'express';
import { bearerAuthAny } from './auth.js';
import { forwardIngest, type IngestAnswer, type IngestEndpoint } from './ingest.js';
import { HttpError } from './vaults.js';

/**
 * The Instagram worker's job routes (#168), mounted at /api/ingest/instagram before the main /api router. They take
 * the worker token or the main one and forward to the ingest service's job API one to one. Only these exact routes
 * (method, path, case, no trailing slash): every other request falls through to the main router and its token, so a
 * stolen worker token can claim jobs and upload results, nothing else.
 */
export function ingestWorkerRouter(d: { token: string; workerToken?: string; ingest?: IngestEndpoint }) {
  const router = express.Router({ caseSensitive: true, strict: true });
  const auth = bearerAuthAny([d.workerToken, d.token]);
  const json = express.json({ limit: 10_000 });

  // A shortcode, checked (after the token) before it becomes part of the ingest service's URL: no `..`, `?` or `/`
  // smuggled in.
  const id = (req: Request, _res: Response, next: NextFunction) => {
    const v = req.params.id;
    next(v === undefined || (typeof v === 'string' && /^[A-Za-z0-9_-]{5,40}$/.test(v)) ? undefined : new HttpError(400, 'Not a job id', 'bad-id'));
  };

  const send = (res: Response, a: IngestAnswer) => {
    if (a.contentType) res.type(a.contentType);
    res.status(a.status).end(a.status === 204 ? undefined : a.body);
  };
  const post = (path: string, internal: (req: Request) => string) =>
    router.post(path, auth, id, json, async (req, res) => {
      send(res, await forwardIngest(d.ingest, 'POST', internal(req), { json: req.body ?? {} }));
    });

  post('/jobs/claim', () => '/instagram/jobs/claim');
  post('/jobs/:id/failure', (req) => `/instagram/jobs/${req.params.id}/failure`);
  post('/jobs/:id/release', (req) => `/instagram/jobs/${req.params.id}/release`);
  post('/worker/heartbeat', () => '/instagram/worker/heartbeat');

  // The result tarball: no body parser, streamed to the ingest service as it arrives, which checks size and content.
  // Only with a Content-Length (no chunked uploads), so the ingest service can refuse an oversize one up front.
  router.put('/jobs/:id/result', auth, id, async (req, res) => {
    const length = req.headers['content-length'];
    if (!length) throw new HttpError(411, 'The upload needs a Content-Length', 'length-required');
    const path = `/instagram/jobs/${req.params.id}/result`;
    send(res, await forwardIngest(d.ingest, 'PUT', path, { stream: { body: req, length }, timeoutMs: 10 * 60_000 }));
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, code: err.code });
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large') return void res.status(413).json({ error: 'The request is too large', code: 'too-large' });
    if (type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid JSON', code: 'invalid' });
    console.error(err);
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  });
  return router;
}
