import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultEvent } from '@karpathy/shared';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote } from './helpers.js';

// Verifies from the MVP plan (specs/01_mvp/plan.md, removed; see git 9c25f72) that had no test yet.

const ROOT = resolve(import.meta.dirname, '../../..');
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function vaultApp() {
  const remote = await makeRemote({ 'Home.md': '# Home\n', 'Other.md': 'other\n' });
  const t = await makeApp(remote.remoteBase);
  cleanups.push(() => t.vaults.close());
  const id = await t.addVault(remote.repo);
  return { ...t, remote, id };
}

/** Opens `GET /vaults/:id/events` over real HTTP and collects the NDJSON events. */
async function openEvents(app: http.RequestListener, id: string) {
  const server = http.createServer(app).listen(0);
  cleanups.push(() => void server.close());
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const connect = async () => {
    const ctrl = new AbortController();
    cleanups.push(() => ctrl.abort());
    const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${id}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
    const events: VaultEvent[] = [];
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) events.push(JSON.parse(line));
        }
      }
    })();
    const waitFor = async (pred: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timeout; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { events, waitFor, close: () => ctrl.abort() };
  };
  return connect;
}

describe('P2 vault admin', () => {
  it('DELETE removes the local clone directory (and never the remote)', async () => {
    const t = await vaultApp();
    const clone = join(t.dirs.vaults, t.id);
    expect(existsSync(join(clone, '.git'))).toBe(true);
    expect((await t.api.delete(`/vaults/${t.id}`)).status).toBe(204);
    expect(existsSync(clone)).toBe(false);
    expect(t.remote.remoteFile('Home.md')).toBe('# Home\n');
  });
});

describe('P3 event stream', () => {
  it('every reconnect starts with a status snapshot of the current state', async () => {
    const t = await vaultApp();
    const connect = await openEvents(t.app, t.id);
    const first = await connect();
    await first.waitFor(() => first.events.length > 0, 2000);
    expect(first.events[0]).toMatchObject({ type: 'status', status: { changedCount: 0 } });
    first.close();
    // Changed while no client is connected.
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'changed while away\n');
    await new Promise((r) => setTimeout(r, 500));
    const second = await connect();
    await second.waitFor(() => second.events.length > 0, 2000);
    expect(second.events[0]).toMatchObject({ type: 'status', status: { changedCount: 1 } });
  });

  it('writes inside .git/ emit no files-changed event', async () => {
    const t = await vaultApp();
    const connect = await openEvents(t.app, t.id);
    const s = await connect();
    await s.waitFor(() => s.events.length > 0, 2000);
    await new Promise((r) => setTimeout(r, 300)); // watcher ready
    const gitDir = join(t.vaults.vaultRootDir(t.id), '.git');
    await mkdir(join(gitDir, 'kai-probe'), { recursive: true });
    await writeFile(join(gitDir, 'kai-probe', 'x'), 'x');
    await writeFile(join(gitDir, 'description'), 'touched\n');
    await new Promise((r) => setTimeout(r, 1200)); // > debounce (300 ms) + margin
    expect(s.events.filter((e) => e.type === 'files-changed')).toEqual([]);
    // Control: a note write in the same window does emit one.
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'note write\n');
    await s.waitFor(() => s.events.some((e) => e.type === 'files-changed'), 1500);
    const fc = s.events.filter((e) => e.type === 'files-changed');
    expect(fc.flatMap((e) => (e as { files: { path: string }[] }).files.map((f) => f.path))).toEqual(['Other.md']);
  });
});

describe('P0/§3.2 opencode server config (deploy/opencode/opencode.json)', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'deploy/opencode/opencode.json'), 'utf8'));

  it('no permission is ever "ask"', () => {
    expect(JSON.stringify(cfg)).not.toMatch(/"ask"/);
  });

  it('hardening flags as in mvp §3.2', () => {
    expect(cfg).toMatchObject({ snapshot: false, formatter: false, lsp: false, default_agent: 'vault-readonly' });
    for (const k of ['external_directory', 'bash', 'webfetch', 'websearch', 'task', 'question', 'doom_loop']) expect(cfg.permission[k], k).toBe('deny');
    expect(cfg.permission.read).toMatchObject({ '*.env': 'deny' });
  });

  it('three agents: vault (edit except .git / opencode config), vault-readonly (no edit), commit-message (no tools)', () => {
    const edit = cfg.agent.vault.permission.edit;
    expect(edit['*']).toBe('allow');
    for (const k of ['*.git', '*.git/*', '*opencode.json', '*opencode.jsonc', '*.opencode/*']) expect(edit[k], k).toBe('deny');
    expect(cfg.agent['vault-readonly'].permission.edit).toBe('deny');
    expect(cfg.agent['commit-message'].permission).toEqual({ '*': 'deny' });
  });
});

describe('P1/§2.5 compose topology (deploy/compose.yml)', () => {
  const compose = JSON.parse(execFileSync('docker', ['compose', '-f', join(ROOT, 'deploy/compose.yml'), 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, DOMAIN: 'ci.example.com' },
  }));
  const svc = compose.services as Record<string, { ports?: unknown[]; user?: string; secrets?: { source: string }[]; environment?: Record<string, string>; volumes?: { source: string; target: string }[] }>;

  it('five services (with the egress proxy and the ingest service); only the proxy publishes ports', () => {
    expect(Object.keys(svc).sort()).toEqual(['backend', 'egress', 'ingest', 'opencode', 'proxy']);
    expect(svc.ingest!.ports ?? []).toEqual([]);
    expect(svc.egress!.ports ?? []).toEqual([]);
    expect(svc.proxy!.ports?.length).toBeGreaterThan(0);
    expect(svc.backend!.ports ?? []).toEqual([]);
    expect(svc.opencode!.ports ?? []).toEqual([]);
  });

  it('opencode has no route to the internet: only the internal network (internal: true) and the egress proxy as HTTP proxy', () => {
    const nets = compose.networks as Record<string, { internal?: boolean }>;
    expect(nets.internal!.internal).toBe(true);
    expect(nets.egress!.internal).toBeFalsy();
    expect(Object.keys((svc.opencode as unknown as { networks: object }).networks)).toEqual(['internal']);
    expect(Object.keys((svc.egress as unknown as { networks: object }).networks).sort()).toEqual(['egress', 'internal']);
    expect(svc.opencode!.environment).toMatchObject({ HTTP_PROXY: 'http://egress:3128', HTTPS_PROXY: 'http://egress:3128' });
  });

  it('backend and opencode run as the same UID/GID', () => {
    expect(svc.backend!.user).toBeTruthy();
    expect(svc.opencode!.user).toBe(svc.backend!.user);
  });

  it('each secret goes only to the service that needs it; opencode gets no GitHub or bearer token', () => {
    const secrets = (s: string) => (svc[s]!.secrets ?? []).map((x) => x.source).sort();
    expect(secrets('backend')).toEqual(['bearer_token', 'github_token', 'ingest_token', 'opencode_password']);
    expect(secrets('proxy')).toEqual(['dns_api_token']);
    expect(secrets('opencode')).toEqual(['opencode_password']);
    expect(secrets('ingest')).toEqual(['gog_keyring_password', 'ingest_token']);
    const env = (s: string) => Object.keys(svc[s]!.environment ?? {});
    expect(env('opencode').filter((k) => /GITHUB|BEARER|GIT_/.test(k))).toEqual([]);
    for (const s of ['backend', 'proxy']) expect(env(s).filter((k) => /_API_KEY$/.test(k)), s).toEqual([]);
  });

  it('volumes: vaults shared by backend + opencode; config backend-only; opencode data opencode-only', () => {
    const vols = (s: string) => (svc[s]!.volumes ?? []).map((v) => `${v.source}:${v.target}`);
    expect(vols('backend')).toEqual(expect.arrayContaining(['vaults:/vaults', 'config:/config']));
    expect(vols('opencode')).toEqual(expect.arrayContaining(['vaults:/vaults', 'opencode-data:/data']));
    expect(vols('opencode').some((v) => v.startsWith('config:'))).toBe(false);
    expect(vols('backend').some((v) => v.startsWith('opencode-data:'))).toBe(false);
  });
});
