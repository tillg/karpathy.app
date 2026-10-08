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

const down = () => new HttpError(503, 'Ingest service not running', 'ingest-down');

export async function callIngest(ep: IngestEndpoint | undefined, method: 'GET' | 'POST', path: string, body?: object): Promise<unknown> {
  if (!ep) throw down();
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
    throw down();
  }
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return out;
  const code = typeof out.error === 'string' ? out.error : 'ingest-error';
  throw new HttpError(res.status, typeof out.message === 'string' ? out.message : `Ingest service: ${code}`, code);
}
