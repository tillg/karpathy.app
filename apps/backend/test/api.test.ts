import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { INCOMING_PATHS_MAX, type VaultEvent } from '@karpathy/shared';
import { makeApp, TOKEN } from './app-helpers.js';
import { makeRemote, sh } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function vaultApp(files: Record<string, string> = { 'Home.md': '# Home\nSee [[Other]]\n', 'Other.md': 'other\n', 'notes/n1.md': 'alpha beta\n' }) {
  const remote = await makeRemote(files);
  const t = await makeApp(remote.remoteBase);
  cleanups.push(() => t.vaults.close());
  const id = await t.addVault(remote.repo);
  return { ...t, remote, id };
}

/** An app whose config already holds vault `v` in clone-failed state (as after a failed clone). */
async function appWithFailedVault(remoteBase: string, v: { repo: string; root: string }) {
  const base = await mkdtemp(join(tmpdir(), 'kai-app-'));
  const dirs = { config: join(base, 'config'), vaults: join(base, 'vaults') };
  await mkdir(dirs.config, { recursive: true });
  const vault = { id: 'v', name: 'v', branch: 'main', ...v, cloned: false, cloneError: "Couldn't clone" };
  await writeFile(join(dirs.config, 'config.json'), JSON.stringify({ vaults: [vault] }));
  const t = await makeApp(remoteBase, {}, dirs);
  cleanups.push(() => t.vaults.close());
  return t;
}

describe('auth', () => {
  it('401 without or with a wrong token, 200 with the right one', async () => {
    const { app } = await makeApp('file:///nowhere/');
    expect((await request(app).get('/api/vaults')).status).toBe(401);
    expect((await request(app).get('/api/vaults').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await request(app).get('/api/vaults').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await request(app).get('/api/nope')).status).toBe(401);
  });

  it('health reports backend + opencode', async () => {
    const { api } = await makeApp('file:///nowhere/', { opencodeHealthy: async () => true });
    expect((await api.get('/health')).body).toEqual({ backend: 'ok', opencode: 'ok', version: 'dev', built: null, deployed: null });
  });

  it('health reports the release version (APP_VERSION)', async () => {
    const { api } = await makeApp('file:///nowhere/', { opencodeHealthy: async () => true, version: '0.3.0' });
    expect((await api.get('/health')).body).toEqual({ backend: 'ok', opencode: 'ok', version: '0.3.0', built: null, deployed: null });
  });

  it('health reports when the release was built and deployed (BUILT_AT, DEPLOYED_AT)', async () => {
    const { api } = await makeApp('file:///nowhere/', { opencodeHealthy: async () => true, version: '0.3.0', built: '2026-10-02T16:20:00Z', deployed: '2026-10-02T16:28:00Z' });
    expect((await api.get('/health')).body).toMatchObject({ version: '0.3.0', built: '2026-10-02T16:20:00Z', deployed: '2026-10-02T16:28:00Z' });
  });
});

describe('vault admin', () => {
  it('add → cloning → ready; appears in list; bad repo → 422 with the git error, nothing stored', async () => {
    const remote = await makeRemote({ 'a.md': 'a' });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const r = await t.api.post('/vaults', { name: 'My Vault', repo: remote.repo });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id: 'my-vault', state: 'cloning', branch: 'main', root: '' });
    await t.vaults.whenCloned('my-vault');
    expect((await t.api.get('/vaults')).body).toEqual([expect.objectContaining({ id: 'my-vault', state: 'ready' })]);

    const bad = await t.api.post('/vaults', { name: 'bad', repo: 'o/does-not-exist' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('repo-unreachable');
    // #48: a human message, no git stderr or container paths.
    expect(bad.body.error).toBe("Couldn't clone o/does-not-exist: the repository doesn't exist, or the server's GitHub token has no access to it.");
    expect((await t.api.get('/vaults')).body).toHaveLength(1);
    expect((await t.api.post('/vaults', { repo: 'not a repo' })).status).toBe(400);
  });

  it('repo without Sources/Wiki → 409 missing-folders; nothing stored, nothing cloned', async () => {
    const remote = await makeRemote({ 'a.md': 'a', 'Wiki/x.md': 'x' }, { structure: false });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const r = await t.api.post('/vaults', { repo: remote.repo });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'missing-folders', missing: ['Sources'] });
    expect((await t.api.get('/vaults')).body).toEqual([]);
    expect(t.store.get().vaults).toEqual([]);
    expect(await readdir(t.dirs.vaults)).toEqual(['.preflight']);
    expect(await readdir(join(t.dirs.vaults, '.preflight'))).toEqual([]);
  });

  it('createFolders → ready with Sources/.gitkeep and Wiki/.gitkeep as uncommitted changes; folders listed', async () => {
    const remote = await makeRemote({ 'a.md': 'a' }, { structure: false });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo, { createFolders: true });
    expect((await t.api.get(`/vaults/${id}`)).body.state).toBe('ready');
    const changes = (await t.api.get(`/vaults/${id}/changes`)).body.map((c: { path: string; kind: string }) => [c.path, c.kind]);
    expect(changes).toEqual([['Sources/.gitkeep', 'untracked'], ['Wiki/.gitkeep', 'untracked']]);
    expect(t.store.get().vaults[0]).not.toHaveProperty('pendingFolders');
    expect((await t.api.get(`/vaults/${id}/files`)).body).toEqual([
      { path: 'a.md', type: 'file' },
      { path: 'Sources', type: 'dir' },
      { path: 'Wiki', type: 'dir' },
    ]);
  });

  it('createFolders over a file named Sources → clone-failed with a clear message', async () => {
    const remote = await makeRemote({ Sources: 'a file', 'Wiki/x.md': 'x' }, { structure: false });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo, { createFolders: true });
    expect((await t.api.get(`/vaults/${id}`)).body).toMatchObject({ state: 'clone-failed', error: "can't create folder Sources: a file with that name exists" });
  });

  it('pendingFolders survive a restart before the clone finished', async () => {
    const remote = await makeRemote({ 'a.md': 'a', 'wiki/b.md': 'b' }, { structure: false });
    const base = await mkdtemp(join(tmpdir(), 'kai-app-'));
    const dirs = { config: join(base, 'config'), vaults: join(base, 'vaults') };
    await mkdir(dirs.config, { recursive: true });
    const vault = { id: 'v', name: 'v', repo: remote.repo, branch: 'main', root: '', cloned: false, pendingFolders: ['Sources'] };
    await writeFile(join(dirs.config, 'config.json'), JSON.stringify({ vaults: [vault] }));
    const t = await makeApp(remote.remoteBase, {}, dirs);
    cleanups.push(() => t.vaults.close());
    await t.vaults.whenCloned('v');
    expect((await t.api.get('/vaults/v/changes')).body.map((c: { path: string }) => c.path)).toEqual(['Sources/.gitkeep']);
  });

  it('two adds of the same repo at once → one attached, the other 409 duplicate', async () => {
    const remote = await makeRemote({ 'a.md': 'a' });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const rs = await Promise.all([t.api.post('/vaults', { repo: remote.repo }), t.api.post('/vaults', { repo: remote.repo })]);
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(rs.find((r) => r.status === 409)!.body.code).toBe('duplicate');
    expect(t.store.get().vaults).toHaveLength(1);
  });

  it('leftover preflight dirs from a crash are removed at startup', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kai-app-'));
    const dirs = { config: join(base, 'config'), vaults: join(base, 'vaults') };
    await mkdir(join(dirs.vaults, '.preflight', 'pre-crashed', 'c'), { recursive: true });
    const t = await makeApp('file:///nowhere/', {}, dirs);
    cleanups.push(() => t.vaults.close());
    expect(await readdir(join(dirs.vaults, '.preflight')).catch(() => [])).toEqual([]);
  });

  it('missing branch → 422 with a readable clone error (#48), nothing stored', async () => {
    const remote = await makeRemote({ 'a.md': 'a' });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const r = await t.api.post('/vaults', { repo: remote.repo, branch: 'nope' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe(`Couldn't clone ${remote.repo}: branch "nope" doesn't exist there.`);
    expect((await t.api.get('/vaults')).body).toEqual([]);
  });

  it('subfolder root: files are scoped to it; missing root folder → 422 root-missing', async () => {
    const remote = await makeRemote({ 'wiki/a.md': 'inside needle', 'wiki/Sources/.gitkeep': '', 'wiki/Wiki/.gitkeep': '', 'top.md': 'outside needle' });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo, { root: 'wiki' });
    expect((await t.api.get(`/vaults/${id}/files`)).body).toEqual([
      { path: 'a.md', type: 'file' },
      { path: 'Sources', type: 'dir' },
      { path: 'Wiki', type: 'dir' },
    ]);
    expect((await t.api.get(`/vaults/${id}/search?q=needle`)).body.hits).toEqual([{ path: 'a.md', line: 1, text: 'inside needle' }]);
    expect((await t.api.get(`/vaults/${id}/file?path=../top.md`)).status).toBe(400);
    const bad = await t.api.post('/vaults', { name: 'x', repo: remote.repo, root: 'nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('root-missing');
    expect((await t.api.get('/vaults')).body).toHaveLength(1);
  });

  it('PATCH: name always; repo/branch/root only on a clean tree', async () => {
    const t = await vaultApp();
    sh(t.remote.obsidian, 'checkout', '-q', '-b', 'other');
    await writeFile(join(t.remote.obsidian, 'branch-only.md'), 'b');
    sh(t.remote.obsidian, 'add', '-A');
    sh(t.remote.obsidian, 'commit', '-q', '-m', 'b');
    sh(t.remote.obsidian, 'push', '-q', '-u', 'origin', 'other');

    await t.api.put(`/vaults/${t.id}/file?path=Other.md`, { content: 'dirty', version: (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.version });
    expect((await t.api.patch(`/vaults/${t.id}`, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await t.api.patch(`/vaults/${t.id}`, { branch: 'other' })).status).toBe(409);
    await t.api.post(`/vaults/${t.id}/discard?path=Other.md`);
    expect((await t.api.patch(`/vaults/${t.id}`, { root: 'missing' })).status).toBe(400);
    const r = await t.api.patch(`/vaults/${t.id}`, { branch: 'other' });
    expect(r.status).toBe(200);
    expect((await t.api.get(`/vaults/${t.id}/files`)).body.map((f: { path: string }) => f.path)).toContain('branch-only.md');
    expect((await t.api.patch(`/vaults/${t.id}`, { root: 'notes' })).status).toBe(200);
    expect((await t.api.get(`/vaults/${t.id}/files`)).body).toEqual([{ path: 'n1.md', type: 'file' }]);
  });

  it('PATCH branch + missing root together → 400 and nothing changed', async () => {
    const t = await vaultApp();
    sh(t.remote.obsidian, 'checkout', '-q', '-b', 'other');
    sh(t.remote.obsidian, 'push', '-q', '-u', 'origin', 'other');
    expect((await t.api.patch(`/vaults/${t.id}`, { branch: 'other', root: 'nope' })).status).toBe(400);
    expect((await t.api.get(`/vaults/${t.id}`)).body).toMatchObject({ branch: 'main', root: '' });
    expect(sh(t.vaults.vaultRootDir(t.id), 'branch', '--show-current').trim()).toBe('main');
  });

  it('duplicate vault (same repo, branch, root) → 409 duplicate (#15, #25 case-insensitive)', async () => {
    const t = await vaultApp({ 'Home.md': '# Home\n', 'notes/n1.md': 'n\n', 'notes/Sources/.gitkeep': '', 'notes/Wiki/.gitkeep': '' });
    const r = await t.api.post('/vaults', { name: 'again', repo: t.remote.repo });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('duplicate');
    expect((await t.api.post('/vaults', { name: 'again', repo: t.remote.repo.toUpperCase() })).body.code).toBe('duplicate');
    expect((await t.api.post('/vaults', { name: 'sub', repo: t.remote.repo, root: 'notes' })).status).toBe(202);
  });

  it('PATCH {} on a clone-failed vault retries the clone (#23)', async () => {
    const remote = await makeRemote({ 'a.md': 'a' });
    // Preflight keeps unreachable repos out, so a clone-failed vault comes from the stored config.
    const t = await appWithFailedVault(remote.remoteBase, { repo: remote.repo, root: '' });
    const id = 'v';
    expect((await t.api.get(`/vaults/${id}`)).body.state).toBe('clone-failed');
    expect((await t.api.patch(`/vaults/${id}`, {})).status).toBe(200);
    await t.vaults.whenCloned(id);
    expect((await t.api.get(`/vaults/${id}`)).body.state).toBe('ready');
  });

  it('fixing the root of a clone-failed vault re-clones it (#9)', async () => {
    const remote = await makeRemote({ 'a.md': 'a' });
    const t = await appWithFailedVault(remote.remoteBase, { repo: remote.repo, root: 'nope' });
    const id = 'v';
    expect((await t.api.get(`/vaults/${id}`)).body.state).toBe('clone-failed');
    const p = await t.api.patch(`/vaults/${id}`, { root: '' });
    expect(p.status).toBe(200);
    await t.vaults.whenCloned(id);
    expect((await t.api.get(`/vaults/${id}`)).body).toMatchObject({ state: 'ready', root: '' });
    expect((await t.api.get(`/vaults/${id}`)).body.error).toBeUndefined();
  });

  it('settings: unknown model → 400 with a readable message; bad threshold → readable message (#16)', async () => {
    const { api } = await makeApp('file:///nowhere/', { availableModels: async () => ['ollama/qwen2.5:3b'] });
    const bad = await api.patch('/settings', { model: 'nope/model-x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not available/i);
    expect(bad.body.error).toContain('ollama/qwen2.5:3b');
    expect((await api.patch('/settings', { model: 'ollama/qwen2.5:3b' })).status).toBe(200);
    for (const v of [2.5, 0, 100000]) {
      const r = await api.patch('/settings', { commitReminderThreshold: v });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('Commit reminder: enter a whole number between 1 and 1000');
    }
  });

  it('PATCH /settings webAccess round-trips; a non-boolean is 400', async () => {
    const { api } = await makeApp('file:///nowhere/');
    expect((await api.get('/settings')).body.webAccess).toBe(true);
    expect((await api.patch('/settings', { webAccess: false })).body.webAccess).toBe(false);
    expect((await api.get('/settings')).body.webAccess).toBe(false);
    expect((await api.patch('/settings', { webAccess: true })).body.webAccess).toBe(true);
    for (const v of ['yes', 1, null]) expect((await api.patch('/settings', { webAccess: v })).status).toBe(400);
  });

  it('PUT github token → GET shows source settings + last4, never the token; DELETE → secret; bad token → 400', async () => {
    const { api } = await makeApp('file:///nowhere/', {}, undefined, 'ghp_secretsecretsecretsecret1111');
    expect((await api.get('/settings')).body.githubToken).toEqual({ source: 'secret', last4: '1111' });
    const tok = 'github_pat_abcdefghijklmnopqrstuvwxyz9876';
    expect((await api.put('/settings/github-token', { token: tok })).status).toBe(204);
    const got = await api.get('/settings');
    expect(got.body.githubToken).toEqual({ source: 'settings', last4: '9876' });
    expect(got.text).not.toContain(tok);
    expect(got.body.commitReminderThreshold).toBe(4);
    expect((await api.delete('/settings/github-token')).status).toBe(204);
    expect((await api.get('/settings')).body.githubToken).toEqual({ source: 'secret', last4: '1111' });
    for (const token of ['short', 'ghp_with space_aaaaaaaaaaaaaaaaaaa']) {
      const r = await api.put('/settings/github-token', { token });
      expect(r.status).toBe(400);
    }
    const none = await makeApp('file:///nowhere/');
    expect((await none.api.get('/settings')).body.githubToken).toEqual({ source: 'none', last4: null });
  });

  it('a token sent to the test route is masked in later messages, though never saved', async () => {
    const t = await makeApp('file:///nowhere/');
    const typed = 'ghp_typedtypedtypedtypedtyped1234';
    expect((await t.api.post('/settings/github-token/test', { token: typed })).status).toBe(200);
    expect(t.githubToken.redact(`fatal: ${typed}`)).toBe('fatal: ***');
    expect((await t.api.get('/settings')).body.githubToken.source).toBe('none');
  });

  it('token test lists each vault: ok for a reachable remote, ok:false with a message for a deleted one', async () => {
    const t = await vaultApp();
    const other = await makeRemote({ 'x.md': 'x' }, { name: 'second' });
    // Both remotes must sit under the app's remoteBase: move the second bare repo next to the first.
    await rename(other.bare, join(t.remote.bare, '..', 'second.git'));
    const id2 = await t.addVault('o/second');
    await rm(join(t.remote.bare, '..', 'second.git'), { recursive: true, force: true });
    const r = await t.api.post('/settings/github-token/test', {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/no github token/i);
    expect(r.body.vaults).toEqual([
      { id: t.id, repo: 'o/vault', ok: true },
      { id: id2, repo: 'o/second', ok: false, error: expect.stringMatching(/o\/second/) },
    ]);
  });

  it('PATCH repo re-clones', async () => {
    const t = await vaultApp();
    const other = await makeRemote({ 'x.md': 'x' }, { name: 'second', structure: false });
    // Same remote base dir layout differs per makeRemote; point the vault at the other bare repo via a symlink.
    await symlink(other.bare, join(t.remote.bare, '..', 'second.git'));
    const r = await t.api.patch(`/vaults/${t.id}`, { repo: 'o/second' });
    expect(r.body.state).toBe('cloning');
    await t.vaults.whenCloned(t.id);
    expect((await t.api.get(`/vaults/${t.id}/files`)).body).toEqual([{ path: 'x.md', type: 'file' }]);
  });

  it('DELETE is blocked while unpushed commits exist (decision 11)', async () => {
    const t = await vaultApp();
    const { rename } = await import('node:fs/promises');
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'x');
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'local only' });
    const r = await t.api.delete(`/vaults/${t.id}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('unpushed');
    await rename(`${t.remote.bare}.away`, t.remote.bare);
  });

  it('DELETE is blocked while uncommitted changes exist, never touches the remote', async () => {
    const t = await vaultApp();
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Home.md`)).body;
    await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'x', version: f.version });
    expect((await t.api.delete(`/vaults/${t.id}`)).status).toBe(409);
    await t.api.post(`/vaults/${t.id}/discard?path=Home.md`);
    expect((await t.api.delete(`/vaults/${t.id}`)).status).toBe(204);
    expect((await t.api.get('/vaults')).body).toEqual([]);
    expect(t.remote.remoteFile('Home.md')).toContain('# Home');
  });
});

describe('files', () => {
  it('lists, reads with a version, PUT with stale version → 409, new file with null version', async () => {
    const t = await vaultApp();
    const files = (await t.api.get(`/vaults/${t.id}/files`)).body;
    expect(files).toEqual([
      { path: 'Home.md', type: 'file' },
      { path: 'notes', type: 'dir' },
      { path: 'notes/n1.md', type: 'file' },
      { path: 'Other.md', type: 'file' },
      { path: 'Sources', type: 'dir' },
      { path: 'Wiki', type: 'dir' },
    ]);
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Home.md`)).body;
    expect(f.content).toContain('[[Other]]');
    const ok = await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'v2', version: f.version });
    expect(ok.status).toBe(200);
    expect(ok.body.version).not.toBe(f.version);
    const stale = await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'v3', version: f.version });
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(ok.body.version);
    // Changed on disk behind the backend's back (as the AI would).
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Home.md'), 'ai edit');
    expect((await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'v3', version: ok.body.version })).status).toBe(409);
    expect((await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'v3', version: ok.body.version, force: true })).status).toBe(200);
    expect((await t.api.put(`/vaults/${t.id}/file?path=new/Note.md`, { content: 'n', version: null })).status).toBe(200);
    expect((await t.api.put(`/vaults/${t.id}/file?path=new/Note.md`, { content: 'n', version: null })).status).toBe(409);
    expect((await t.api.get(`/vaults/${t.id}/file?path=missing.md`)).status).toBe(404);
  });

  it('binary files are flagged, not decoded (#20)', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]));
    const f = (await t.api.get(`/vaults/${t.id}/file?path=pic.png`)).body;
    expect(f).toMatchObject({ binary: true, content: '' });
    expect(f.version).toBeTruthy();
    expect((await t.api.get(`/vaults/${t.id}/file?path=Home.md`)).body.binary).toBe(false);
  });

  it('raw: media file bytes with Content-Type and nosniff', async () => {
    const t = await vaultApp();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'pic.png'), bytes);
    const r = await t.api.get(`/vaults/${t.id}/raw?path=pic.png`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body).equals(bytes)).toBe(true);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    const h = await request(t.app).head(`/api/vaults/${t.id}/raw?path=pic.png`).set('Authorization', `Bearer ${TOKEN}`);
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBe(String(bytes.length));
    const part = await t.api.get(`/vaults/${t.id}/raw?path=pic.png`).set('Range', 'bytes=0-3');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${bytes.length}`);
  });

  it('raw: pdf and unknown types are attachments; escapes are refused', async () => {
    const t = await vaultApp();
    const root = t.vaults.vaultRootDir(t.id);
    await writeFile(join(root, 'doc.pdf'), '%PDF-1.4');
    await writeFile(join(root, 'x.bin'), 'bin');
    await mkdir(join(root, 'dir'));
    await mkdir(join(root, '.obsidian'));
    await writeFile(join(root, '.obsidian', 'pic.png'), 'x');
    await symlink('/etc/hosts', join(root, 'evil.png'));
    const get = (p: string) => t.api.get(`/vaults/${t.id}/raw?path=${encodeURIComponent(p)}`);
    const pdf = await get('doc.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^attachment/);
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    const bin = await get('x.bin');
    expect(bin.headers['content-type']).toBe('application/octet-stream');
    expect(bin.headers['content-disposition']).toMatch(/^attachment/);
    const md = await get('Home.md');
    expect(md.status).toBe(200);
    expect(md.headers['content-disposition']).toMatch(/^attachment/);
    for (const p of ['../x', '.git/config', '.obsidian/pic.png', './pic.png', 'evil.png', 'dir']) expect((await get(p)).status).toBe(400);
    expect((await get('missing.png')).status).toBe(404);
    expect((await request(t.app).get(`/api/vaults/${t.id}/raw?path=Home.md`)).status).toBe(401);
  });

  it.each(['CON.md', 'nul', 'a\tb.md', 'Neue Notiz?.md', 'x/', 'a<b>.md', 'com1.txt'])('new file name %j → 400 bad-name', async (p) => {
    const t = await vaultApp();
    const r = await t.api.put(`/vaults/${t.id}/file?path=${encodeURIComponent(p)}`, { content: 'x', version: null });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad-name');
  });

  it.each(['.opencode/plugin/x.js', 'opencode.json', 'sub/opencode.jsonc', '.opencode'])('file API refuses to create harness config %j (#27)', async (p) => {
    const t = await vaultApp();
    const r = await t.api.put(`/vaults/${t.id}/file?path=${encodeURIComponent(p)}`, { content: '{}', version: null });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad-name');
  });

  it.each(['--upload-pack=touch /tmp/x', '-c', 'a..b', 'feature/x y', 'x~1', 'x^', 'x:y', '@{u}', 'a.lock', '/x', 'x/'])('branch %j is rejected (#30)', async (branch) => {
    const t = await vaultApp();
    const r1 = await t.api.patch(`/vaults/${t.id}`, { branch });
    expect(r1.status).toBe(400);
    const r2 = await t.api.post('/vaults', { name: 'b', repo: t.remote.repo, branch });
    expect(r2.status).toBe(400);
  });

  it('valid branch names still work', async () => {
    const t = await vaultApp();
    sh(t.remote.obsidian, 'checkout', '-q', '-b', 'feature/wiki-2026.09');
    sh(t.remote.obsidian, 'push', '-q', '-u', 'origin', 'feature/wiki-2026.09');
    expect((await t.api.patch(`/vaults/${t.id}`, { branch: 'feature/wiki-2026.09' })).status).toBe(200);
  });

  it('search query with a newline → 400, not a 500 with the rg command', async () => {
    const t = await vaultApp();
    const r = await t.api.get(`/vaults/${t.id}/search?q=${encodeURIComponent('a\nb')}`);
    expect(r.status).toBe(400);
    expect(r.body.error).not.toContain('rg');
  });

  it('rejects traversal and symlinks', async () => {
    const t = await vaultApp();
    await symlink('/etc/hosts', join(t.vaults.vaultRootDir(t.id), 'evil.md'));
    expect((await t.api.get(`/vaults/${t.id}/file?path=../../etc/hosts`)).status).toBe(400);
    expect((await t.api.get(`/vaults/${t.id}/file?path=evil.md`)).status).toBe(400);
    expect((await t.api.put(`/vaults/${t.id}/file?path=.git/config`, { content: 'x', version: null })).status).toBe(400);
  });

  it('DELETE file with version', async () => {
    const t = await vaultApp();
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body;
    expect((await t.api.delete(`/vaults/${t.id}/file?path=Other.md&version=wrong`)).status).toBe(409);
    expect((await t.api.delete(`/vaults/${t.id}/file?path=Other.md&version=${f.version}`)).status).toBe(204);
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body).toEqual([{ path: 'Other.md', kind: 'deleted', version: null }]);
  });

  it('DELETE of the last file in a folder removes the emptied folders, like git rm', async () => {
    const t = await vaultApp({ 'Home.md': '# Home\n', 'a/b/c.md': 'c\n', 'a/keep.md': 'k\n' });
    const del = async (p: string) => {
      const f = (await t.api.get(`/vaults/${t.id}/file?path=${p}`)).body;
      expect((await t.api.delete(`/vaults/${t.id}/file?path=${p}&version=${f.version}`)).status).toBe(204);
    };
    const paths = async () => ((await t.api.get(`/vaults/${t.id}/files`)).body as { path: string }[]).map((f) => f.path);
    await del('a/b/c.md');
    expect(await paths()).toEqual(expect.arrayContaining(['a', 'a/keep.md']));
    expect(await paths()).not.toContain('a/b');
    await del('a/keep.md');
    expect(await paths()).toEqual(['Home.md', 'Sources', 'Wiki']);
  });

  it('search finds content and file names', async () => {
    const t = await vaultApp();
    const hits = (await t.api.get(`/vaults/${t.id}/search?q=ALPHA`)).body;
    expect(hits).toEqual({ hits: [{ path: 'notes/n1.md', line: 1, text: 'alpha beta' }], truncated: false });
    // "other" is in the name Other.md and in Home.md's content: content hits win, name-only hits only for files without one.
    expect((await t.api.get(`/vaults/${t.id}/search?q=other`)).body.hits).toEqual([
      { path: 'Other.md', line: 1, text: 'other' },
      { path: 'Home.md', line: 2, text: 'See [[Other]]' },
    ]);
  });

  it('search is deterministic, never shows a file only by name when its content matches, and reports truncation (#7)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`n/Needle ${String(i).padStart(3, '0')}.md`] = 'x\nneedle one\nneedle two\nneedle three\n';
    files['only-name-needle.md'] = 'nothing here';
    const t = await vaultApp(files);
    const a = (await t.api.get(`/vaults/${t.id}/search?q=needle`)).body;
    const b = (await t.api.get(`/vaults/${t.id}/search?q=needle`)).body;
    expect(a).toEqual(b);
    expect(a.truncated).toBe(true);
    expect(a.hits).toHaveLength(200);
    expect(a.hits.filter((h: { line: number }) => h.line === 0).map((h: { path: string }) => h.path)).toEqual(['only-name-needle.md']);
    expect((await t.api.get(`/vaults/${t.id}/search?q=%22needle%20two%22`)).body.truncated).toBe(false);
  });

  it('#99 search lists notes whose file name matches the query before passing mentions', async () => {
    const t = await vaultApp({
      'A/mentions.md': 'we went to Similaun once\n',
      'B/also.md': 'similaun again\n',
      'Wiki/tours/similaun.md': '# Tour\nthe Similaun tour\n',
      'Wiki/z-name-only-SIMILAUN-x.md': 'nothing',
    });
    const hits = (await t.api.get(`/vaults/${t.id}/search?q=Similaun`)).body.hits as { path: string; line: number }[];
    expect(hits.map((h) => h.path)).toEqual([
      'Wiki/z-name-only-SIMILAUN-x.md',
      'Wiki/tours/similaun.md',
      'A/mentions.md',
      'B/also.md',
    ]);
  });

  it('#107 multi-word search finds notes containing all words, shows lines of any word; quotes mean exact phrase', async () => {
    const t = await vaultApp({
      'a.md': 'Similaun is high\nunrelated\nand Cevedale too\n',
      'b.md': 'only similaun here\n',
      'c.md': 'similaun\n\ncevedale\n',
      'd.md': 'similaun cevedale together\n',
    });
    const q = async (s: string) => (await t.api.get(`/vaults/${t.id}/search?q=${encodeURIComponent(s)}`)).body.hits;
    expect(await q('similaun CEVEDALE')).toEqual([
      { path: 'a.md', line: 1, text: 'Similaun is high' },
      { path: 'a.md', line: 3, text: 'and Cevedale too' },
      { path: 'c.md', line: 1, text: 'similaun' },
      { path: 'c.md', line: 3, text: 'cevedale' },
      { path: 'd.md', line: 1, text: 'similaun cevedale together' },
    ]);
    expect(await q('"similaun cevedale"')).toEqual([{ path: 'd.md', line: 1, text: 'similaun cevedale together' }]);
    expect(((await q('similaun')) as unknown[]).length).toBe(4);
  });

  it('new file whose path differs only in case from an existing one → 409 exists-case (#6)', async () => {
    const t = await vaultApp();
    const r = await t.api.put(`/vaults/${t.id}/file?path=OTHER.md`, { content: 'x', version: null });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('exists-case');
    expect((await t.api.put(`/vaults/${t.id}/file?path=NOTES/x.md`, { content: 'x', version: null })).body.code).toBe('exists-case');
    expect((await t.api.put(`/vaults/${t.id}/file?path=notes/x.md`, { content: 'x', version: null })).status).toBe(200);
  });
});

describe('git API', () => {
  it('changes + diff + discard', async () => {
    const t = await vaultApp();
    for (const p of ['Home.md', 'Other.md']) {
      const f = (await t.api.get(`/vaults/${t.id}/file?path=${p}`)).body;
      await t.api.put(`/vaults/${t.id}/file?path=${p}`, { content: `changed ${p}\n`, version: f.version });
    }
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body).toHaveLength(2);
    expect((await t.api.get(`/vaults/${t.id}/changes/diff?path=Home.md`)).body.diff).toContain('+changed Home.md');
    await t.api.post(`/vaults/${t.id}/discard?path=Home.md`);
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body).toEqual([{ path: 'Other.md', kind: 'modified', version: expect.any(String) }]);
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ state: 'ready', changedCount: 1, unpushedCount: 0, busy: 'none' });
  });

  it('discard of the last new file in a new folder removes the emptied folders', async () => {
    const t = await vaultApp();
    await t.api.put(`/vaults/${t.id}/file?path=${encodeURIComponent('new/deep/x.md')}`, { content: 'x\n', version: null });
    await t.api.post(`/vaults/${t.id}/discard?path=${encodeURIComponent('new/deep/x.md')}`);
    const paths = ((await t.api.get(`/vaults/${t.id}/files`)).body as { path: string }[]).map((f) => f.path);
    expect(paths.filter((p) => p.startsWith('new'))).toEqual([]);
  });

  it('commit = pull → commit all → push; the remote has one new commit, tree clean', async () => {
    const t = await vaultApp();
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Home.md`)).body;
    await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'mine', version: f.version });
    await t.api.put(`/vaults/${t.id}/file?path=added.md`, { content: 'added', version: null });
    await t.remote.obsidianPush({ 'Other.md': 'from obsidian' });
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'Update 2 files' });
    expect(r.body).toMatchObject({ pushed: true });
    expect(t.remote.remoteLog().slice(0, 2)).toEqual(['Update 2 files', 'obsidian edit']);
    expect(t.remote.remoteFile('added.md')).toBe('added');
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ changedCount: 0, unpushedCount: 0 });
    expect(sh(t.remote.bare, 'log', '-1', '--format=%B')).not.toContain('Co-authored-by');
  });

  it('commit message proposal falls back to "Update N files" without opencode', async () => {
    const t = await vaultApp();
    await t.api.put(`/vaults/${t.id}/file?path=x.md`, { content: 'x', version: null });
    expect((await t.api.post(`/vaults/${t.id}/commit-message`)).body).toEqual({ message: 'Update 1 file', fallback: true });
  });

  it('AI-touched set: trailer iff a touched path is committed; discard removes; survives restart; empty after commit', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'ai');
    await t.vaults.markAiTouched(t.id, ['Other.md']);
    await t.api.post(`/vaults/${t.id}/discard?path=Other.md`);
    await t.api.put(`/vaults/${t.id}/file?path=h.md`, { content: 'human', version: null });
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'human only' });
    expect(sh(t.remote.bare, 'log', '-1', '--format=%B')).not.toContain('Co-authored-by');

    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'ai again');
    await t.vaults.markAiTouched(t.id, ['Other.md']);
    const t2 = await makeApp(t.remote.remoteBase, {}, t.dirs);
    cleanups.push(() => t2.vaults.close());
    expect(t2.vaults.aiTouched(t.id)).toEqual(['Other.md']);
    await t2.api.post(`/vaults/${t.id}/commit`, { message: 'with ai' });
    expect(sh(t.remote.bare, 'log', '-1', '--format=%B')).toContain('Co-authored-by: karpathy.app agent');
    expect(t2.vaults.aiTouched(t.id)).toEqual([]);
  });

  it('pull on open brings Obsidian changes; skipped while a shared holder runs', async () => {
    const t = await vaultApp();
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    const release = await t.vaults.lock(t.id).acquireShared('turn');
    await t.api.post(`/vaults/${t.id}/open`);
    expect((await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.content).toBe('other\n');
    release();
    await t.api.post(`/vaults/${t.id}/open`);
    expect((await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.content).toBe('remote v2\n');
  });

  it('commit issued during a long save waits for it', async () => {
    const t = await vaultApp();
    const release = await t.vaults.lock(t.id).acquireShared('save');
    let committed = false;
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'x');
    const c = t.api.post(`/vaults/${t.id}/commit`, { message: 'm' }).then((r) => {
      committed = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(committed).toBe(false);
    expect((await t.api.get(`/vaults/${t.id}/status`)).body.busy).toBe('sync');
    release();
    expect((await c).body.pushed).toBe(true);
  });

  it('an offline pull on open is reported in the status', async () => {
    const t = await vaultApp();
    const { rename } = await import('node:fs/promises');
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    expect((await t.api.post(`/vaults/${t.id}/open`)).body.pullError).toBeTruthy();
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    expect((await t.api.post(`/vaults/${t.id}/open`)).body.pullError).toBeUndefined();
  });

  it('discard with a version refuses when the file changed while waiting (#32)', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'human\n');
    const ch = (await t.api.get(`/vaults/${t.id}/changes`)).body;
    expect(ch).toEqual([{ path: 'Other.md', kind: 'modified', version: expect.any(String) }]);
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'human + AI\n');
    const r = await t.api.post(`/vaults/${t.id}/discard?path=Other.md&version=${ch[0].version}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('stale');
    const now = (await t.api.get(`/vaults/${t.id}/changes`)).body[0].version;
    expect((await t.api.post(`/vaults/${t.id}/discard?path=Other.md&version=${now}`)).status).toBe(204);
  });

  it('commit with the reviewed file list refuses when more changes arrived while waiting (#33)', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'human\n');
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'ai.md'), 'ai\n');
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'Update 1 file', paths: ['Other.md'] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('changes-moved');
    expect(r.body.paths.sort()).toEqual(['Other.md', 'ai.md']);
    expect((await t.api.post(`/vaults/${t.id}/commit`, { message: 'Update 2 files', paths: ['ai.md', 'Other.md'] })).body.pushed).toBe(true);
  });

  it('branch change refused for unpushed commits says so (#35)', async () => {
    const t = await vaultApp();
    const { rename } = await import('node:fs/promises');
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'x');
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'm' });
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    const r = await t.api.patch(`/vaults/${t.id}`, { branch: 'other' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('unpushed');
    expect(r.body.error).toMatch(/unpushed/);
  });

  it('push failure → unpushed; retry push later succeeds', async () => {
    const t = await vaultApp();
    const { rename } = await import('node:fs/promises');
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'offline');
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'offline' });
    expect(r.body).toMatchObject({ pushed: false });
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ changedCount: 0, unpushedCount: 1 });
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    expect((await t.api.post(`/vaults/${t.id}/push`)).body).toMatchObject({ pushed: true });
    expect((await t.api.get(`/vaults/${t.id}/status`)).body.unpushedCount).toBe(0);
    expect(t.remote.remoteLog()[0]).toBe('offline');
  });

  it('conflict: 423 on writes, survives restart, resolution returns to normal', async () => {
    const t = await vaultApp();
    const f = (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body;
    await t.api.put(`/vaults/${t.id}/file?path=Other.md`, { content: 'mine\n', version: f.version });
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n' });
    const c = await t.api.post(`/vaults/${t.id}/commit`, { message: 'x' });
    expect(c.status).toBe(409);
    const st = (await t.api.get(`/vaults/${t.id}/status`)).body;
    expect(st).toMatchObject({ state: 'conflict', conflictPaths: ['Other.md'] });
    expect((await t.api.put(`/vaults/${t.id}/file?path=Home.md`, { content: 'x', version: null, force: true })).status).toBe(423);
    expect((await t.api.get(`/vaults/${t.id}/conflicts/sides?path=Other.md`)).body).toEqual({ mine: 'mine\n', theirs: 'theirs\n' });

    const t2 = await makeApp(t.remote.remoteBase, {}, t.dirs);
    cleanups.push(() => t2.vaults.close());
    expect((await t2.api.get(`/vaults/${t.id}`)).body.state).toBe('conflict');
    const res = await t2.api.post(`/vaults/${t.id}/conflicts/resolve`, { path: 'Other.md', choice: 'both' });
    expect(res.body).toMatchObject({ state: 'ready', conflictPaths: [] });
    expect(await readFile(join(t2.vaults.vaultRootDir(t.id), 'Other.md'), 'utf8')).toBe('mine\n');
    const names = (await t2.api.get(`/vaults/${t.id}/changes`)).body.map((x: { path: string }) => x.path);
    expect(names).toEqual(expect.arrayContaining(['Other.md', expect.stringMatching(/^Other\.conflict-\d{4}-\d{2}-\d{2}\.md$/)]));
    expect((await t2.api.post(`/vaults/${t.id}/commit`, { message: 'resolved' })).body.pushed).toBe(true);
  });
});

describe('incoming changes', () => {
  it('status reports incoming changes after a fetch, files untouched', async () => {
    const t = await vaultApp();
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ incomingCount: 0, incomingPaths: [] });
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    expect(await t.vaults.fetchRemote(t.id)).toBe('fetched');
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ incomingCount: 1, incomingPaths: ['Other.md'] });
    expect((await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.content).toBe('other\n');
  });

  it('incomingPaths is capped at INCOMING_PATHS_MAX, incomingCount stays exact', async () => {
    const t = await vaultApp();
    const files: Record<string, string> = {};
    for (let i = 0; i < INCOMING_PATHS_MAX + 5; i++) files[`many/f${i}.md`] = `${i}\n`;
    await t.remote.obsidianPush(files);
    expect(await t.vaults.fetchRemote(t.id)).toBe('fetched');
    const st = (await t.api.get(`/vaults/${t.id}/status`)).body;
    expect(st.incomingCount).toBe(INCOMING_PATHS_MAX + 5);
    expect(st.incomingPaths).toHaveLength(INCOMING_PATHS_MAX);
  });

  it('background fetch runs next to a turn, skips while a git op holds the lock', async () => {
    const t = await vaultApp();
    const lock = t.vaults.lock(t.id);
    const turn = await lock.acquireShared('turn');
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    expect(await t.vaults.fetchRemote(t.id)).toBe('fetched');
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ incomingCount: 1, busy: 'turn' });
    turn();
    const ex = await lock.acquireExclusive();
    await t.remote.obsidianPush({ 'Home.md': 'remote home\n' });
    expect(await t.vaults.fetchRemote(t.id)).toBe('skipped');
    ex();
    const a = t.vaults.fetchRemote(t.id);
    const b = t.vaults.fetchRemote(t.id);
    expect(b).toBe(a);
    expect(await a).toBe('fetched');
    expect((await t.api.get(`/vaults/${t.id}/status`)).body.incomingCount).toBe(2);
  });

  it('offline background fetch keeps the last count and reports pullError', async () => {
    const t = await vaultApp();
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    expect(await t.vaults.fetchRemote(t.id)).toBe('fetched');
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    expect(await t.vaults.fetchRemote(t.id)).toBe('offline');
    const st = (await t.api.get(`/vaults/${t.id}/status`)).body;
    expect(st.pullError).toBeTruthy();
    expect(st.pullError).not.toContain(TOKEN);
    expect(st.incomingCount).toBe(1);
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    expect(await t.vaults.fetchRemote(t.id)).toBe('fetched');
    expect((await t.api.get(`/vaults/${t.id}/status`)).body.pullError).toBeUndefined();
  });

  it('open pulls even while a background fetch runs', async () => {
    const t = await vaultApp();
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    const fetching = t.vaults.fetchRemote(t.id);
    const st = (await t.api.post(`/vaults/${t.id}/open`)).body;
    expect(st.incomingCount).toBe(0);
    expect((await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.content).toBe('remote v2\n');
    await fetching;
  });

  it('pull route: takes incoming changes, waits for a racing turn, refuses in conflict', async () => {
    const t = await vaultApp();
    await t.remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    await t.vaults.fetchRemote(t.id);
    const ok = await t.api.post(`/vaults/${t.id}/pull`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'ready', incomingCount: 0 });
    expect((await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body.content).toBe('remote v2\n');

    const turn = await t.vaults.lock(t.id).acquireShared('turn');
    let done = false;
    const waiting = t.api.post(`/vaults/${t.id}/pull`).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    turn();
    expect((await waiting).status).toBe(200);

    await rename(t.remote.bare, `${t.remote.bare}.away`);
    expect((await t.api.post(`/vaults/${t.id}/pull`)).body.pullError).toBeTruthy();
    await rename(`${t.remote.bare}.away`, t.remote.bare);

    const f = (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body;
    await t.api.put(`/vaults/${t.id}/file?path=Other.md`, { content: 'mine\n', version: f.version });
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n' });
    const clash = await t.api.post(`/vaults/${t.id}/pull`);
    expect(clash.status).toBe(200);
    expect(clash.body).toMatchObject({ state: 'conflict', conflictPaths: ['Other.md'] });
    const again = await t.api.post(`/vaults/${t.id}/pull`);
    expect(again.status).toBe(423);
    expect(again.body.code).toBe('conflict');
  });
});

describe('event stream', () => {
  it('snapshot first; a file written behind the back → files-changed + status within 1 s', async () => {
    const t = await vaultApp();
    const server = http.createServer(t.app).listen(0);
    cleanups.push(() => void server.close());
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const ctrl = new AbortController();
    cleanups.push(() => ctrl.abort());
    const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${t.id}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const events: VaultEvent[] = [];
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
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
    await waitFor(() => events.length > 0, 2000);
    expect(events[0]).toMatchObject({ type: 'status', status: { changedCount: 0 } });
    await new Promise((r) => setTimeout(r, 300)); // watcher ready
    const t0 = Date.now();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'written by the AI');
    await waitFor(() => events.some((e) => e.type === 'files-changed'), 1500);
    await waitFor(() => events.some((e) => e.type === 'status' && e.status.changedCount === 1), 1500);
    expect(Date.now() - t0).toBeLessThan(1500);
    const fc = events.find((e) => e.type === 'files-changed');
    expect(fc).toMatchObject({ type: 'files-changed', files: [{ path: 'Other.md', version: expect.any(String) }] });
    ctrl.abort();
    await pump;
  });

  it('connect fetches, the interval fetches while connected, nothing after disconnect', async () => {
    const remote = await makeRemote({ 'Home.md': '# Home\n', 'Other.md': 'other\n' });
    const t = await makeApp(remote.remoteBase, {}, undefined, undefined, { fetchIntervalMs: 200 });
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo);
    const server = http.createServer(t.app).listen(0);
    cleanups.push(() => void server.close());
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const connect = async () => {
      const ctrl = new AbortController();
      cleanups.push(() => ctrl.abort());
      const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${id}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const events: VaultEvent[] = [];
      const pump = (async () => {
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
      const waitFor = async (pred: (e: VaultEvent) => boolean, ms: number) => {
        const end = Date.now() + ms;
        while (!events.some(pred)) {
          if (Date.now() > end) throw new Error(`timeout; events: ${JSON.stringify(events)}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      return { waitFor, close: async () => { ctrl.abort(); await pump; } };
    };
    const incoming = (n: number) => (e: VaultEvent) => e.type === 'status' && e.status.incomingCount === n;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await remote.obsidianPush({ 'Other.md': 'v2\n' });
    const s1 = await connect();
    await s1.waitFor(incoming(1), 1000);
    await remote.obsidianPush({ 'Home.md': 'home v2\n' });
    await s1.waitFor(incoming(2), 1000);
    await s1.close();
    await sleep(250);
    await remote.obsidianPush({ 'new.md': 'n\n' });
    await sleep(1000);
    expect((await t.api.get(`/vaults/${id}/status`)).body.incomingCount).toBe(2);

    const s2 = await connect();
    await s2.waitFor(incoming(3), 1000);
    // Removing the vault while subscribed: no tick may run (and reject) for a vault that is gone.
    await t.api.post(`/vaults/${id}/open`);
    expect((await t.api.delete(`/vaults/${id}`)).status).toBe(204);
    await sleep(1000);
    await s2.close();
  });
});
