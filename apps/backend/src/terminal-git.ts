import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { bearerAuth } from './auth.js';
import { HttpError, type Vaults } from './vaults.js';

/**
 * The terminal's `vault` command (#175, deploy/terminal/vault): commit, push and pull through the backend, the same
 * calls as the app's Commit button, with the same secret scan. Git stays read-only in the terminal (ADR 0008), so its
 * config can't reach the backend's git; the terminal's token (`terminal_git_token`) opens these routes and nothing
 * else, and the main token isn't taken here. A commit the scan blocks has to go through the app: no `allowSecrets`.
 */
export function terminalGitRouter(d: { terminalGitToken: string; vaults: Vaults }) {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use(bearerAuth(d.terminalGitToken));
  router.use(express.json({ limit: 100_000 }));
  const commitBody = z.object({ message: z.string().min(1).max(10_000) }).strict();

  router.get('/vaults/:id/status', async (req, res) => void res.json(await d.vaults.status(req.params.id!)));
  router.get('/vaults/:id/changes', async (req, res) => void res.json(await d.vaults.changes(req.params.id!)));
  router.post('/vaults/:id/commit', async (req, res) => {
    const { message } = commitBody.parse(req.body ?? {});
    res.json(await d.vaults.commit(req.params.id!, message));
  });
  router.post('/vaults/:id/push', async (req, res) => void res.json(await d.vaults.push(req.params.id!)));
  router.post('/vaults/:id/pull', async (req, res) => void res.json(await d.vaults.pull(req.params.id!)));

  router.use((_req, res) => void res.status(404).json({ error: 'not found' }));
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues.map((i) => i.message).join('; '), code: 'invalid' });
    if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid JSON', code: 'invalid' });
    console.error(err);
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  });
  return router;
}
