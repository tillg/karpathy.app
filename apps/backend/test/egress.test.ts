import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EGRESS, ensureEgress, INTERNAL_TARGET, startOpencode, testDir } from './opencode-container.js';

// The egress proxy (deploy/egress) as the opencode container uses it: public destinations only.

let oc: Awaited<ReturnType<typeof startOpencode>>;
let proxyPort: number;
const vaultsDir = join(testDir('egress'), 'vaults');

beforeAll(async () => {
  oc = await startOpencode(vaultsDir);
  proxyPort = ensureEgress();
}, 300_000);
afterAll(() => oc?.stop());

/** busybox wget inside opencode, through the proxy (it reads only lowercase env and ignores NO_PROXY: `-Y off` goes direct). */
function wget(url: string, ...opts: string[]) {
  const r = spawnSync('docker', ['exec', '-e', `http_proxy=http://${EGRESS}:3128`, oc.name, 'wget', '-S', '-T', '10', '-qO-', ...opts, url], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// A public-internet check is skipped offline.
const online = await fetch('http://example.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(() => true, () => false);

describe('egress proxy', () => {
  it('metadata refused', () => {
    const r = wget('http://169.254.169.254/');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('403');
  });

  it('internal host refused', () => {
    // The target answers when reached directly, so the 403 below is the proxy's verdict, not a dead host.
    expect(wget(`http://${INTERNAL_TARGET}/`, '-Y', 'off').code).toBe(0);
    const r = wget(`http://${INTERNAL_TARGET}/`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('403');
  });

  it('CONNECT to an internal address is refused', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const s = connect(proxyPort, '127.0.0.1', () => s.write('CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n'));
      s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]!); s.destroy(); });
      s.once('error', reject);
    });
    expect(status).toContain('403');
  });

  it('CONNECT to a non-443 port is refused, plain http to a low port too', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const s = connect(proxyPort, '127.0.0.1', () => s.write('CONNECT example.com:25 HTTP/1.1\r\nHost: example.com:25\r\n\r\n'));
      s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]!); s.destroy(); });
      s.once('error', reject);
    });
    expect(status).toContain('403');
    const r = wget('http://example.com:22/');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('403');
  });

  it('loopback API refused without password', () => {
    // Direct (-Y off), the way the plugin client and the NO_PROXY loopback reach it: the password is the guard.
    const r = wget('http://127.0.0.1:4096/session', '-Y', 'off');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('401');
  });

  it.skipIf(!online)('redirect to internal refused', () => {
    // A public redirector sends wget on to the metadata address; the proxy refuses that second hop. Two
    // services, because one being down (httpbin.org answered 503 for a release) isn't a proxy failure.
    const redirectors = ['http://httpbin.org/redirect-to', 'http://postman-echo.com/redirect-to'];
    const tries = redirectors.map((u) => wget(`${u}?url=http://169.254.169.254/`));
    const r = tries.find((t) => t.out.includes('Location: http://169.254.169.254/')) ?? tries[0]!;
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Location: http://169.254.169.254/');
    expect(r.out).toContain('403');
  });

  it.skipIf(!online)('public allowed', () => {
    const r = wget('http://example.com/');
    expect(r.code).toBe(0);
    expect(r.out).toContain('200 OK');
  });

  it.skipIf(!online)('CONNECT to a public host is allowed', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const s = connect(proxyPort, '127.0.0.1', () => s.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
      s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]!); s.destroy(); });
      s.once('error', reject);
    });
    expect(status).toContain('200');
  });
});

