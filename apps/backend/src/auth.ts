import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Single-user bearer token check in front of every /api route (mvp §3.2), constant time. */
export function bearerAuth(secret: string): RequestHandler {
  if (!secret) throw new Error('auth.bearer_token (settings) must be set');
  const want = createHash('sha256').update(secret).digest();
  return (req, res, next) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const got = createHash('sha256').update(token).digest();
    if (token && timingSafeEqual(got, want)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}
