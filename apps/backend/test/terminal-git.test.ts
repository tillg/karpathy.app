import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote } from './helpers.js';

// The terminal's `vault` command (#175): commit, push and pull through the backend, like the app's Commit button. Git
// stays read-only in the terminal; its token reaches these routes and nothing else.
const GIT_TOKEN = 'terminal-git-token-456';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const remote = await makeRemote({ 'a.md': 'a\n' });
  const t = await makeApp(remote.remoteBase, { deps: { terminalGitToken: GIT_TOKEN } });
  cleanups.push(() => t.vaults.close());
  const id = await t.addVault(remote.repo);
  const as = (token: string) => ({
    get: (p: string) => request(t.app).get(`/api/vault-cli${p}`).set('Authorization', `Bearer ${token}`),
    post: (p: string, body?: object) => request(t.app).post(`/api/vault-cli${p}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  return { ...t, id, remote, cli: as(GIT_TOKEN), as };
}

describe('vault-cli routes (the terminal token)', () => {
  it('status, changes, then commit and push them; the remote has the commit', async () => {
    const t = await setup();
    await writeFile(join(t.dirs.vaults, t.id, 'b.md'), 'b\n');
    expect((await t.cli.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path)).toEqual(['b.md']);
    const r = await t.cli.post(`/vaults/${t.id}/commit`, { message: 'From the terminal' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(t.remote.remoteLog()[0]).toBe('From the terminal');
    expect((await t.cli.get(`/vaults/${t.id}/status`)).body).toMatchObject({ state: 'ready', changedCount: 0, unpushedCount: 0 });
    expect((await t.cli.post(`/vaults/${t.id}/pull`)).status).toBe(200);
    expect((await t.cli.post(`/vaults/${t.id}/push`)).status).toBe(200);
  });

  it('a secret the scan finds blocks the commit; the terminal cannot wave it through', async () => {
    const t = await setup();
    await writeFile(join(t.dirs.vaults, t.id, 'leak.md'), `token: ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}\n`);
    const r = await t.cli.post(`/vaults/${t.id}/commit`, { message: 'leak', allowSecrets: ['leak.md'] });
    expect(r.status).toBe(400);
    const again = await t.cli.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('secrets');
    expect(t.remote.remoteLog()[0]).not.toBe('leak');
  });

  it('the terminal token opens nothing else; the main token is not taken here; no token, no access', async () => {
    const t = await setup();
    expect((await request(t.app).get('/api/vaults').set('Authorization', `Bearer ${GIT_TOKEN}`)).status).toBe(401);
    expect((await request(t.app).get(`/api/vaults/${t.id}/status`).set('Authorization', `Bearer ${GIT_TOKEN}`)).status).toBe(401);
    expect((await t.as(TOKEN).get(`/vaults/${t.id}/status`)).status).toBe(401);
    expect((await t.as('').get(`/vaults/${t.id}/status`)).status).toBe(401);
  });

  it('without a terminal token configured the routes are not there (the main router answers)', async () => {
    const remote = await makeRemote({ 'a.md': 'a\n' });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const r = await request(t.app).get('/api/vault-cli/vaults/x/status').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(404);
  });
});
