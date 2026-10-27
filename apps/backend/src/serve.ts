import type { Server } from 'node:http';
import type { Express } from 'express';
import { UPLOAD_TIMEOUT_MS } from './ingest-worker.js';

/**
 * Starts the HTTP server. Node's default requestTimeout (300 s) bounds the whole request, body included: it would cut
 * off a worker's result upload on a slow line (150 MB over 3 Mbit/s ≈ 400 s) before the route's own forwarding timeout.
 * So it is that timeout plus a minute; headersTimeout (60 s, against slowloris) and keepAliveTimeout keep Node's
 * defaults.
 */
export function serve(app: Express, port: number, host?: string, onListening?: () => void): Server {
  const server = host === undefined ? app.listen(port, onListening) : app.listen(port, host, onListening);
  server.requestTimeout = UPLOAD_TIMEOUT_MS + 60_000;
  return server;
}
