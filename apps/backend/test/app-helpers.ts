import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app.js';
import { ConfigStore } from '../src/config-store.js';
import { GitHubToken } from '../src/github-token.js';
import { Vaults, type VaultsEnv } from '../src/vaults.js';
import { identity } from './helpers.js';

export const TOKEN = 'test-token-123';

export interface MakeAppOptions {
  /** Overrides for the app's dependencies (health checks, models, version, …). */
  deps?: Partial<AppDeps>;
  /** Reuse these config/vaults dirs (a "restart"); default: fresh temp dirs. */
  dirs?: { config: string; vaults: string };
  githubSecret?: string;
  env?: Partial<VaultsEnv>;
}

export async function makeApp(remoteBase: string, { deps = {}, dirs, githubSecret, env = {} }: MakeAppOptions = {}) {
  const base = dirs ? null : await mkdtemp(join(tmpdir(), 'kai-app-'));
  const configDir = dirs?.config ?? join(base!, 'config');
  const vaultsDir = dirs?.vaults ?? join(base!, 'vaults');
  const store = await ConfigStore.open(configDir);
  const githubToken = new GitHubToken(store, githubSecret);
  const vaults = new Vaults(store, { vaultsDir, remoteBase, identity, githubToken: () => githubToken.current(), redact: (m) => githubToken.redact(m), ...env });
  await vaults.init();
  const app = createApp({ token: TOKEN, vaults, store, githubToken, ...deps });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const api = {
    get: (p: string) => request(app).get(`/api${p}`).set(auth),
    post: (p: string, body?: object) => request(app).post(`/api${p}`).set(auth).send(body),
    put: (p: string, body?: object) => request(app).put(`/api${p}`).set(auth).send(body),
    patch: (p: string, body?: object) => request(app).patch(`/api${p}`).set(auth).send(body),
    delete: (p: string) => request(app).delete(`/api${p}`).set(auth),
  };
  /** Adds a vault and waits for its clone. */
  async function addVault(repo: string, more: object = {}) {
    const r = await api.post('/vaults', { name: repo.split('/')[1], repo, ...more });
    await vaults.whenCloned(r.body.id);
    return r.body.id as string;
  }
  return { app, api, store, vaults, githubToken, addVault, dirs: { config: configDir, vaults: vaultsDir } };
}
