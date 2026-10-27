import { HttpError } from './vaults.js';

/**
 * The ingest service's internal endpoint (deploy/ingest/server.py): Admin › Instagram goes through here. Every call
 * carries the ingest token; the answer is passed on as is, errors as `{ error, code }` like every backend error.
 * Bodies (the Instagram password) are forwarded once and never logged.
 */
export interface IngestEndpoint {
  url: string;
  token: string;
}

const notRunning = () => new HttpError(503, 'Ingest service not running', 'ingest-down');

export async function callIngest(ep: IngestEndpoint | undefined, method: 'GET' | 'POST', path: string, body?: object): Promise<unknown> {
  if (!ep) throw notRunning();
  let res: Response;
  try {
    res = await fetch(`${ep.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ep.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // A login waits up to 90 s for Instagram to connect or to ask for a code.
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw notRunning();
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return out;
  // The ingest token didn't match: a deploy problem, never the user's login (a 401 would log the app out).
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The ingest service refused the backend (ingest token mismatch)', 'ingest-auth');
  const code = typeof out.error === 'string' ? out.error : 'ingest-error';
  throw new HttpError(res.status, typeof out.message === 'string' ? out.message : `Ingest service: ${code}`, code);
}

/** What the ingest service answered, passed through by forwardIngest's caller. */
export interface IngestAnswer {
  status: number;
  contentType: string | null;
  body: Buffer;
}

/**
 * Forwards a worker's job call (src/ingest-worker.ts) to the ingest service with the ingest token and returns its
 * status and body as they are (204 included): the worker reads the ingest service's own `{error, message}`.
 * `stream` is sent as it arrives, never buffered (the result tarball may be hundreds of MB), with its Content-Length.
 * Unreachable → 503 ingest-down, an ingest 401/403 → 502 ingest-auth, as in callIngest.
 */
export async function forwardIngest(
  ep: IngestEndpoint | undefined,
  method: 'POST' | 'PUT',
  path: string,
  { json, stream, timeoutMs = 30_000 }: { json?: unknown; stream?: { body: AsyncIterable<Uint8Array>; length: string }; timeoutMs?: number } = {},
): Promise<IngestAnswer> {
  if (!ep) throw notRunning();
  const headers: Record<string, string> = { Authorization: `Bearer ${ep.token}` };
  let body: string | AsyncIterable<Uint8Array> | undefined;
  if (stream) {
    headers['Content-Type'] = 'application/gzip';
    headers['Content-Length'] = stream.length;
    body = stream.body;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  let res: Response;
  try {
    // `duplex: 'half'` is what fetch needs for a streamed request body (not yet in TypeScript's RequestInit).
    res = await fetch(`${ep.url}${path}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
      ...(stream ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
  } catch {
    throw notRunning();
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new HttpError(502, 'The ingest service refused the backend (ingest token mismatch)', 'ingest-auth');
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}
