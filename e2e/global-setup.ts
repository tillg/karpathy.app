import { mkdirSync, rmSync } from 'node:fs';
import { Api, BASE_URL, REMOTES } from './helpers';

export default async function globalSetup() {
  // Tags this run's vaults so teardown never removes another concurrent run's vaults.
  process.env.E2E_RUN_ID = Date.now().toString(36);
  // A killed run may leave the web-access spec's lock behind (a fresh run holds no lock yet).
  rmSync('tmp/web-access.lock', { recursive: true, force: true });
  mkdirSync(REMOTES, { recursive: true });
  const api = await Api.create();
  const res = await api.ctx.get('/api/health');
  if (!res.ok()) throw new Error(`dev stack not reachable (${BASE_URL}/api/health → ${res.status()}); run just dev up`);
  await api.ctx.dispose();
}
