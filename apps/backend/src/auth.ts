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

/**
 * Like bearerAuth, for routes more than one token may use (the Instagram worker's job routes: the worker token or the
 * main one). Empty tokens are left out; each comparison is constant time.
 */
export function bearerAuthAny(secrets: (string | undefined)[]): RequestHandler {
  const wants = secrets.filter((s): s is string => Boolean(s)).map((s) => createHash('sha256').update(s).digest());
  if (!wants.length) throw new Error('bearerAuthAny needs at least one token');
  return (req, res, next) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const got = createHash('sha256').update(token).digest();
    // Every token is compared, so the time doesn't tell which one matched.
    const ok = wants.reduce((any, want) => timingSafeEqual(got, want) || any, false);
    if (token && ok) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}
