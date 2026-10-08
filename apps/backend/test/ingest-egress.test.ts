import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTERNAL_TARGET, startIngest } from './opencode-container.js';

// The ingest container (deploy/ingest) as compose runs it: on an internal network whose only way out is the
// egress proxy. Its HTTP clients (httpx for the resolvers, gog for Gmail) must use the proxy, and the proxy
// refuses everything that isn't public.

let ing: Awaited<ReturnType<typeof startIngest>>;

beforeAll(async () => {
  ing = await startIngest();
}, 600_000);
afterAll(() => ing?.stop());

/** Runs Python inside the ingest container; prints one line. */
function py(code: string, env: Record<string, string> = {}) {
  const r = spawnSync('docker', ['exec', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ing.name, 'python', '-c', code], { encoding: 'utf8', timeout: 60_000 });
  return `${r.stdout}${r.stderr}`.trim();
}
/** httpx GET through the container's proxy env: the status code, or the error's class name. */
const get = (url: string, trustEnv = true) => py(
  `import httpx\ntry:\n  print(httpx.get(${JSON.stringify(url)}, timeout=15, trust_env=${trustEnv ? 'True' : 'False'}).status_code)\nexcept Exception as e:\n  print(type(e).__name__)`,
);

const online = await fetch('https://example.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(() => true, () => false);

describe('ingest container confinement', () => {
  it('the backend stand-in, the metadata service and a private IP are refused by the proxy', () => {
    expect(get(`http://${INTERNAL_TARGET}/`)).toBe('403');
    expect(get('http://169.254.169.254/')).toBe('403');
    expect(get('http://10.0.0.1/')).toBe('403');
  });

  it('there is no direct route out: without the proxy nothing public is reached', () => {
    expect(get('https://example.com/', false)).toMatch(/Error$/);
  });

  it.skipIf(!online)('a public URL succeeds through the proxy (httpx honours HTTPS_PROXY)', () => {
    expect(get('https://example.com/')).toBe('200');
  });

  it.skipIf(!online)('gog honours HTTPS_PROXY: Google answers (401 for a bogus token)', () => {
    const r = spawnSync('docker', ['exec', ing.name, 'gog', 'gmail', 'labels', 'list', '--access-token', 'bogus'], { encoding: 'utf8', timeout: 60_000 });
    expect(`${r.stdout}${r.stderr}`).toContain('401');
  });
});
