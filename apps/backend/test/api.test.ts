import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INCOMING_PATHS_MAX, MAX_UPLOAD_BYTES, type VaultEvent } from '@karpathy/shared';
import { makeApp, TOKEN } from './app-helpers.js';
import { AI_TRAILER } from '../src/repo.js';
import { makeRemote, sh } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Paths and types of a `/files` listing, without its dates. */
const pathTypes = (body: { path: string; type: string }[]) => body.map(({ path, type }) => ({ path, type }));

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
  const t = await makeApp(remoteBase, { dirs });
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
    const { api } = await makeApp('file:///nowhere/', { deps: { opencodeHealthy: async () => true } });
    expect((await api.get('/health')).body).toEqual({ backend: 'ok', opencode: 'ok', version: 'dev', built: null, deployed: null });
  });

  it('health reports the release version (APP_VERSION)', async () => {
    const { api } = await makeApp('file:///nowhere/', { deps: { opencodeHealthy: async () => true, version: '0.3.0' } });
    expect((await api.get('/health')).body).toEqual({ backend: 'ok', opencode: 'ok', version: '0.3.0', built: null, deployed: null });
  });

  it('health reports when the release was built and deployed (BUILT_AT, DEPLOYED_AT)', async () => {
    const { api } = await makeApp('file:///nowhere/', { deps: { opencodeHealthy: async () => true, version: '0.3.0', built: '2026-10-02T16:20:00Z', deployed: '2026-10-02T16:28:00Z' } });
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
    expect(pathTypes((await t.api.get(`/vaults/${id}/files`)).body)).toEqual([
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
    const t = await makeApp(remote.remoteBase, { dirs });
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
    const t = await makeApp('file:///nowhere/', { dirs });
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
    expect(pathTypes((await t.api.get(`/vaults/${id}/files`)).body)).toEqual([
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
    expect(pathTypes((await t.api.get(`/vaults/${t.id}/files`)).body)).toEqual([{ path: 'n1.md', type: 'file' }]);
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
    const { api } = await makeApp('file:///nowhere/', { deps: { availableModels: async () => [{ id: 'ollama/qwen2.5:3b', input: { image: false, pdf: false } }] } });
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

  it('settings model default and override', async () => {
    const models = [{ id: 'ollama/qwen2.5:3b', input: { image: false, pdf: false } }, { id: 'ollama/qwen3-vl:2b', input: { image: true, pdf: false } }];
    const { api } = await makeApp('file:///nowhere/', { defaultModel: 'ollama/qwen2.5:3b', deps: { availableModels: async () => models } });
    expect((await api.get('/settings')).body).toMatchObject({ model: 'ollama/qwen2.5:3b', defaultModel: 'ollama/qwen2.5:3b', modelOverridden: false });
    expect((await api.patch('/settings', { model: 'ollama/qwen3-vl:2b' })).body).toMatchObject({ model: 'ollama/qwen3-vl:2b', modelOverridden: true });
    expect((await api.patch('/settings', { model: null })).body).toMatchObject({ model: 'ollama/qwen2.5:3b', modelOverridden: false });
    expect((await api.patch('/settings', { model: 'nope/x' })).status).toBe(400);
  });

  it('settings answer while opencode hangs: modelInput null', async () => {
    const { api } = await makeApp('file:///nowhere/', { deps: { availableModels: () => new Promise(() => undefined) } });
    const t0 = Date.now();
    const r = await api.get('/settings').timeout(10_000);
    expect(r.status).toBe(200);
    expect(r.body.modelInput).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await api.patch('/settings', { commitReminderThreshold: 5 }).timeout(10_000)).body.modelInput).toBeNull();
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
    const { api } = await makeApp('file:///nowhere/', { githubSecret: 'ghp_secretsecretsecretsecret1111' });
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
    expect(pathTypes((await t.api.get(`/vaults/${t.id}/files`)).body)).toEqual([{ path: 'x.md', type: 'file' }]);
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

  it('an unpushed AI commit folded back by a pull stays AI-touched, so the next commit keeps the trailer', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'ai.md'), 'by the AI\n');
    await t.vaults.markAiTouched(t.id, ['ai.md']);
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    const failed = (await t.api.post(`/vaults/${t.id}/commit`, { message: 'ai page' })).body;
    expect(failed.pushed).toBe(false);
    expect(t.vaults.aiTouched(t.id)).toEqual([]);
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    await t.remote.obsidianPush({ 'Other.md': 'moved on\n' }); // GitHub moved on: the pull folds the commit back
    expect((await t.api.post(`/vaults/${t.id}/pull`)).status).toBe(200);
    expect(t.vaults.aiTouched(t.id)).toEqual(['ai.md']);
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'ai page again' });
    expect(sh(t.remote.bare, 'log', '-1', '--format=%B')).toContain(AI_TRAILER);
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

describe('file dates (#122)', () => {
  const D1 = Date.parse('2020-01-02T03:04:05Z');
  const D2 = Date.parse('2021-05-06T07:08:09Z');
  const D3 = Date.parse('2022-09-10T11:12:13Z');
  type Entry = { path: string; modified?: number; ai?: number; human?: number };
  const listing = async (t: { api: { get: (p: string) => request.Test } }, id: string) =>
    new Map(((await t.api.get(`/vaults/${id}/files`)).body as Entry[]).map((e) => [e.path, e]));
  /** Commit + push from the "Obsidian" clone with a fixed committer date (the author date stays 2000, as after a rebase). */
  const datedPush = async (remote: Awaited<ReturnType<typeof makeRemote>>, files: Record<string, string>, date: number, msg = 'dated') => {
    sh(remote.obsidian, 'pull', '-q', '--ff-only');
    for (const [p, c] of Object.entries(files)) {
      await mkdir(join(remote.obsidian, p, '..'), { recursive: true });
      await writeFile(join(remote.obsidian, p), c);
    }
    sh(remote.obsidian, 'add', '-A');
    execFileSync('git', ['commit', '-q', '--date=2000-01-01T00:00:00Z', '-m', msg], {
      cwd: remote.obsidian,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Obsidian', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'Obsidian', GIT_COMMITTER_EMAIL: 'o@example.com', GIT_COMMITTER_DATE: new Date(date).toISOString() },
    });
    sh(remote.obsidian, 'push', '-q');
  };
  async function datedApp(files: Record<string, string> = { 'Home.md': 'home\n' }, opts: { root?: string; structure?: boolean } = {}) {
    const remote = await makeRemote(files, { structure: opts.structure ?? true });
    await datedPush(remote, { [`${opts.root ? `${opts.root}/` : ''}old.md`]: 'old\n' }, D1);
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo, opts.root ? { root: opts.root } : {});
    return { ...t, remote, id };
  }

  it("modified is the last commit time, not the clone's mtime", async () => {
    const t = await datedApp();
    const files = await listing(t, t.id);
    expect(files.get('old.md')?.modified).toBe(D1);
    expect(files.get('Home.md')?.modified).toBeGreaterThan(D2);
    expect(files.get('Wiki')).not.toHaveProperty('modified');
  });

  it("an uncommitted file's modified is its mtime", async () => {
    const t = await datedApp();
    await t.api.put(`/vaults/${t.id}/file?path=old.md`, { content: 'changed\n', version: (await t.api.get(`/vaults/${t.id}/file?path=old.md`)).body.version });
    await utimes(join(t.vaults.vaultRootDir(t.id), 'old.md'), D2 / 1000, D2 / 1000);
    expect((await listing(t, t.id)).get('old.md')?.modified).toBe(D2);
  });

  it('human comes from commits without the AI trailer only', async () => {
    const t = await datedApp();
    await datedPush(t.remote, { 'h.md': 'h\n' }, D2);
    await datedPush(t.remote, { 'm.md': 'm\n' }, D3, `mixed\n\n${AI_TRAILER}\n`);
    expect((await t.api.post(`/vaults/${t.id}/pull`)).status).toBe(200);
    const files = await listing(t, t.id);
    expect(files.get('h.md')?.human).toBe(D2);
    expect(files.get('m.md')?.modified).toBe(D3);
    expect(files.get('m.md')).not.toHaveProperty('human');
    expect(files.get('old.md')?.human).toBe(D1);
  });

  it('dates follow a new commit', async () => {
    const t = await datedApp();
    expect((await listing(t, t.id)).get('old.md')?.modified).toBe(D1);
    await datedPush(t.remote, { 'old.md': 'newer\n' }, D3);
    await t.api.post(`/vaults/${t.id}/pull`);
    expect((await listing(t, t.id)).get('old.md')?.modified).toBe(D3);
  });

  it('dates follow a root change (same HEAD)', async () => {
    const t = await datedApp({ 'Home.md': 'home\n', 'wiki/Sources/.gitkeep': '', 'wiki/Wiki/.gitkeep': '' });
    await datedPush(t.remote, { 'wiki/deep.md': 'inner\n' }, D2);
    await datedPush(t.remote, { 'deep.md': 'outer\n' }, D3);
    await t.api.post(`/vaults/${t.id}/pull`);
    expect((await listing(t, t.id)).get('deep.md')?.modified).toBe(D3);
    expect((await t.api.patch(`/vaults/${t.id}`, { root: 'wiki' })).status).toBe(200);
    expect((await listing(t, t.id)).get('deep.md')?.modified).toBe(D2);
  });

  it('dates with a vault root: paths are vault-relative, outside paths are ignored', async () => {
    const t = await datedApp({ 'wiki/a.md': 'a\n', 'wiki/Sources/.gitkeep': '', 'wiki/Wiki/.gitkeep': '', 'other/b.md': 'b\n' }, { root: 'wiki', structure: false });
    const files = await listing(t, t.id);
    expect(files.get('old.md')?.modified).toBe(D1);
    expect(files.get('a.md')?.modified).toBeGreaterThan(D2);
    expect([...files.keys()].some((p) => p.includes('b.md'))).toBe(false);
  });
});

describe('edit stamps (#122)', () => {
  type Entry = { path: string; ai?: number; human?: number };
  const entry = async (t: { api: { get: (p: string) => request.Test } }, id: string, path: string) =>
    ((await t.api.get(`/vaults/${id}/files`)).body as Entry[]).find((e) => e.path === path);
  const upload = (t: { app: Parameters<typeof request>[0]; id: string }, query: string) =>
    request(t.app).post(`/api/vaults/${t.id}/raw?${query}`).set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'application/octet-stream').send(Buffer.from([1, 2, 3]));
  const recent = (ms?: number) => ms !== undefined && Date.now() - ms < 60_000;

  it('survive a restart and a commit', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'x.md'), 'ai');
    await t.vaults.markAiTouched(t.id, ['x.md']);
    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
    cleanups.push(() => t2.vaults.close());
    expect((await t2.api.post(`/vaults/${t.id}/commit`, { message: 'with ai' })).status).toBe(200);
    expect(recent((await entry(t2, t.id, 'x.md'))?.ai)).toBe(true);
  });

  it('an AI edit stamps ai, not human', async () => {
    const t = await vaultApp();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'new.md'), 'ai');
    await t.vaults.markAiTouched(t.id, ['new.md', '/outside/root.md']);
    const e = await entry(t, t.id, 'new.md');
    expect(recent(e?.ai)).toBe(true);
    expect(e).not.toHaveProperty('human');
    expect(Object.keys(t.store.get().editStamps[t.id] ?? {})).toEqual(['new.md']);
  });

  it('save, create and upload stamp human, not ai', async () => {
    const t = await vaultApp({ 'Wiki/foo/foo.md': '# Foo\n' });
    await t.api.put(`/vaults/${t.id}/file?path=n.md`, { content: 'n', version: null });
    expect((await upload(t, 'name=a.png&note=Wiki/foo/foo.md')).status).toBe(201);
    for (const p of ['n.md', 'Wiki/foo/a.png']) {
      const e = await entry(t, t.id, p);
      expect(recent(e?.human), p).toBe(true);
      expect(e, p).not.toHaveProperty('ai');
    }
  });

  it('discard drops only stamps newer than the last commit; a move carries them; removal deletes them', async () => {
    const t = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n' });
    const root = t.vaults.vaultRootDir(t.id);
    // Untracked: discard deletes the file and its stamps.
    await writeFile(join(root, 'u.md'), 'ai');
    await t.vaults.markAiTouched(t.id, ['u.md']);
    await t.api.post(`/vaults/${t.id}/discard?path=u.md`);
    expect(t.store.get().editStamps[t.id]?.['u.md']).toBeUndefined();
    // Committed AI page, then a human edit that is discarded: the AI stamp describes HEAD and stays.
    await writeFile(join(root, 'c.md'), 'ai');
    await t.vaults.markAiTouched(t.id, ['c.md']);
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'ai page' });
    await new Promise((r) => setTimeout(r, 1100)); // commit times have 1 s resolution
    const v = (await t.api.get(`/vaults/${t.id}/file?path=c.md`)).body.version;
    await t.api.put(`/vaults/${t.id}/file?path=c.md`, { content: 'human', version: v });
    const humanBefore = t.store.get().editStamps[t.id]?.['c.md']?.human;
    expect(humanBefore).toBeDefined();
    await t.api.post(`/vaults/${t.id}/discard?path=c.md`);
    expect(t.store.get().editStamps[t.id]?.['c.md']?.ai).toBeDefined();
    expect(t.store.get().editStamps[t.id]?.['c.md']?.human).toBeUndefined();
    // Move into own folder carries the stamps.
    await t.vaults.markAiTouched(t.id, ['Wiki/serien/foo.md']);
    expect((await upload(t, 'name=a.png&note=Wiki/serien/foo.md')).status).toBe(201);
    expect(recent((await entry(t, t.id, 'Wiki/serien/foo/foo.md'))?.ai)).toBe(true);
    expect(t.store.get().editStamps[t.id]?.['Wiki/serien/foo.md']).toBeUndefined();
    // Removal deletes them (removal needs a clean vault).
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'move' });
    expect((await t.api.delete(`/vaults/${t.id}`)).status).toBe(204);
    expect(t.store.get().editStamps[t.id]).toBeUndefined();
  });

  it('notes rewritten by a move into its own folder are stamped human', async () => {
    const t = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n', 'Wiki/index.md': 'See [[serien/foo]]\n' });
    const before = Date.now(); // after the seed commit, whose time also counts as human
    const r = await upload(t, 'name=a.png&note=Wiki/serien/foo.md');
    expect(r.body.rewritten).toEqual(['Wiki/index.md']);
    expect((await entry(t, t.id, 'Wiki/index.md'))?.human).toBeGreaterThanOrEqual(before);
  });

  it('stamps of deleted files are dropped', async () => {
    const t = await vaultApp();
    const abs = join(t.vaults.vaultRootDir(t.id), 'gone.md');
    await writeFile(abs, 'ai');
    await t.vaults.markAiTouched(t.id, ['gone.md']);
    await rm(abs);
    await t.api.get(`/vaults/${t.id}/files`);
    await writeFile(abs, 'back');
    expect(await entry(t, t.id, 'gone.md')).not.toHaveProperty('ai');
  });
});

describe('files', () => {
  it('lists, reads with a version, PUT with stale version → 409, new file with null version', async () => {
    const t = await vaultApp();
    const files = pathTypes((await t.api.get(`/vaults/${t.id}/files`)).body);
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

  it('lists .agents (the vault skills) but no other dot-folder; its files open', async () => {
    const t = await vaultApp();
    const root = t.vaults.vaultRootDir(t.id);
    await mkdir(join(root, '.agents/skills/ingest'), { recursive: true });
    await writeFile(join(root, '.agents/skills/ingest/SKILL.md'), 'skill');
    await mkdir(join(root, '.obsidian'), { recursive: true });
    await writeFile(join(root, '.obsidian/app.json'), '{}');
    const paths = pathTypes((await t.api.get(`/vaults/${t.id}/files`)).body).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['.agents', '.agents/skills', '.agents/skills/ingest', '.agents/skills/ingest/SKILL.md']));
    expect(paths.filter((p) => p.startsWith('.') && !p.startsWith('.agents'))).toEqual([]);
    expect((await t.api.get(`/vaults/${t.id}/file?path=.agents/skills/ingest/SKILL.md`)).body.content).toBe('skill');
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

  it('#130 graph lists the notes and the links between them', async () => {
    const t = await vaultApp({ 'Home.md': '[[Other]] [[Other]] [[missing]] ![[pic.png]]\n', 'Other.md': '[n](notes/n1.md)\n', 'notes/n1.md': '`[[Home]]`\n', 'pic.png': 'x' });
    expect((await t.api.get(`/vaults/${t.id}/graph`)).body).toEqual({
      nodes: [{ path: 'Home.md' }, { path: 'notes/n1.md' }, { path: 'Other.md' }],
      links: [{ source: 'Home.md', target: 'Other.md' }, { source: 'Other.md', target: 'notes/n1.md' }],
    });
  });

  it('graph nodes carry the frontmatter type', async () => {
    const t = await vaultApp({ 'Wiki/a.md': '---\ntags: [x]\ntype: entity\n---\n# A\n', 'Wiki/b.md': '---\ntype: "concept"  # note\n---\n', 'c.md': 'type: entity\n' });
    expect((await t.api.get(`/vaults/${t.id}/graph`)).body.nodes).toEqual([{ path: 'c.md' }, { path: 'Wiki/a.md', type: 'entity' }, { path: 'Wiki/b.md', type: 'concept' }]);
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

  it('status counts changed paths under Input/ as inputChangedCount', async () => {
    const t = await vaultApp();
    for (const p of ['Input/mail-a/index.md', 'Input/mail-a/original.eml', 'Input/web-b/index.md', 'added.md', 'Wiki/Input/x.md'])
      await t.api.put(`/vaults/${t.id}/file?path=${encodeURIComponent(p)}`, { content: 'x\n', version: null });
    expect((await t.api.get(`/vaults/${t.id}/status`)).body).toMatchObject({ changedCount: 5, inputChangedCount: 3 });
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
    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
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

    const t2 = await makeApp(t.remote.remoteBase, { dirs: t.dirs });
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
    // The GitHub token appears in git's error (as part of the remote path) and must be redacted.
    const secret = 'ghs_backgroundFetchSecret123';
    const remote = await makeRemote({ 'Home.md': '# Home\n', 'Other.md': 'other\n' });
    await symlink(join(remote.base, 'remotes'), join(remote.base, secret));
    const t = await makeApp(`file://${remote.base}/${secret}/`, { githubSecret: secret });
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    await remote.obsidianPush({ 'Other.md': 'remote v2\n' });
    expect(await t.vaults.fetchRemote(id)).toBe('fetched');
    await rename(remote.bare, `${remote.bare}.away`);
    expect(await t.vaults.fetchRemote(id)).toBe('offline');
    const st = (await t.api.get(`/vaults/${id}/status`)).body;
    expect(st.pullError).toContain('***');
    expect(st.pullError).not.toContain(secret);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(secret);
    expect(st.incomingCount).toBe(1);
    await rename(`${remote.bare}.away`, remote.bare);
    expect(await t.vaults.fetchRemote(id)).toBe('fetched');
    expect((await t.api.get(`/vaults/${id}/status`)).body.pullError).toBeUndefined();
  });

  it('a repo change drops the old vault\'s pullError', async () => {
    const t = await vaultApp();
    await rename(t.remote.bare, `${t.remote.bare}.away`);
    expect(await t.vaults.fetchRemote(t.id)).toBe('offline');
    await rename(`${t.remote.bare}.away`, t.remote.bare);
    const other = await makeRemote({ 'x.md': 'x' }, { name: 'second', structure: false });
    await symlink(other.bare, join(t.remote.bare, '..', 'second.git'));
    await t.api.patch(`/vaults/${t.id}`, { repo: 'o/second' });
    await t.vaults.whenCloned(t.id);
    expect((await t.api.get(`/vaults/${t.id}/status`)).body.pullError).toBeUndefined();
  });

  it('subscribing to an unknown vault keeps no runtime for it', async () => {
    const t = await vaultApp();
    expect((await t.api.get('/vaults/nope/events')).status).toBe(404);
    expect((t.vaults as unknown as { rt: Map<string, unknown> }).rt.has('nope')).toBe(false);
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

/** Serves `app` on a free port and returns a connect() to a vault's event stream (NDJSON). */
async function eventStreams(app: http.RequestListener) {
  const server = http.createServer(app).listen(0);
  cleanups.push(() => void server.close());
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return async (id: string) => {
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
    /** Waits until some event matches `pred`. */
    const waitFor = async (pred: (e: VaultEvent) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!events.some(pred)) {
        if (Date.now() > end) throw new Error(`timeout; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { events, waitFor, close: async () => { ctrl.abort(); await pump; } };
  };
}

describe('event stream', () => {
  it('snapshot first; a file written behind the back → files-changed + status within 1 s', async () => {
    const t = await vaultApp();
    const connect = await eventStreams(t.app);
    const { events, waitFor, close } = await connect(t.id);
    await waitFor(() => true, 2000);
    expect(events[0]).toMatchObject({ type: 'status', status: { changedCount: 0 } });
    await new Promise((r) => setTimeout(r, 300)); // watcher ready
    const t0 = Date.now();
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'written by the AI');
    await waitFor((e) => e.type === 'files-changed', 1500);
    await waitFor((e) => e.type === 'status' && e.status.changedCount === 1, 1500);
    expect(Date.now() - t0).toBeLessThan(1500);
    const fc = events.find((e) => e.type === 'files-changed');
    expect(fc).toMatchObject({ type: 'files-changed', files: [{ path: 'Other.md', version: expect.any(String) }] });
    await close();
  });

  it('connect fetches, the interval fetches while connected, nothing after disconnect', async () => {
    const remote = await makeRemote({ 'Home.md': '# Home\n', 'Other.md': 'other\n' });
    const t = await makeApp(remote.remoteBase, { env: { fetchIntervalMs: 200 } });
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo);
    const connect = await eventStreams(t.app);
    const incoming = (n: number) => (e: VaultEvent) => e.type === 'status' && e.status.incomingCount === n;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await remote.obsidianPush({ 'Other.md': 'v2\n' });
    const s1 = await connect(id);
    await s1.waitFor(incoming(1), 1000);
    await remote.obsidianPush({ 'Home.md': 'home v2\n' });
    await s1.waitFor(incoming(2), 1000);
    await s1.close();
    await sleep(250);
    await remote.obsidianPush({ 'new.md': 'n\n' });
    await sleep(1000);
    expect((await t.api.get(`/vaults/${id}/status`)).body.incomingCount).toBe(2);

    const s2 = await connect(id);
    await s2.waitFor(incoming(3), 1000);
    // Removing the vault while subscribed: no tick may run (and reject) for a vault that is gone.
    await t.api.post(`/vaults/${id}/open`);
    expect((await t.api.delete(`/vaults/${id}`)).status).toBe(204);
    const fetches = vi.spyOn(t.vaults, 'fetchRemote');
    await sleep(1000);
    expect(fetches).not.toHaveBeenCalled();
    await s2.close();
  });
});

describe('upload', () => {
  /** POST /raw with a binary body (the `api.post` helper sends JSON). */
  const upload = (t: { app: Parameters<typeof request>[0]; id: string }, query: string, body: Buffer = Buffer.from([1, 2, 3])) =>
    request(t.app).post(`/api/vaults/${t.id}/raw?${query}`).set('Authorization', `Bearer ${TOKEN}`).set('Content-Type', 'application/octet-stream').send(body);

  it('upload: stores bytes, returns path and version', async () => {
    const t = await vaultApp({ 'Wiki/foo/foo.md': '# Foo\n', 'Sources/x/index.md': '# X\n' });
    const r = await upload(t, 'name=a.png&note=Wiki/foo/foo.md');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ path: 'Wiki/foo/a.png', version: expect.any(String), size: 3 });
    expect((await readFile(join(t.vaults.vaultRootDir(t.id), 'Wiki/foo/a.png'))).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect((await t.api.get(`/vaults/${t.id}/file?path=Wiki/foo/a.png`)).body.version).toBe(r.body.version);
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path)).toContain('Wiki/foo/a.png');
    expect(t.vaults.aiTouched(t.id)).toEqual([]);

    const s = await upload(t, 'name=b.png&note=Sources/x/index.md');
    expect(s.status).toBe(201);
    expect(s.body.path).toBe('Sources/x/b.png');
  });

  it('upload: -2, -3 on collisions, vault-wide, case-insensitive', async () => {
    const t = await vaultApp({ 'Wiki/foo/foo.md': '# Foo\n', 'Wiki/foo/Y.png': 'y', 'Other/deep/w.png': 'w' });
    const note = 'note=Wiki/foo/foo.md';
    expect((await upload(t, `name=x.png&${note}`)).body.path).toBe('Wiki/foo/x.png');
    expect((await upload(t, `name=x.png&${note}`)).body.path).toBe('Wiki/foo/x-2.png');
    expect((await upload(t, `name=x.png&${note}`)).body.path).toBe('Wiki/foo/x-3.png');
    expect((await upload(t, `name=y.png&${note}`)).body.path).toBe('Wiki/foo/y-2.png');
    expect((await upload(t, `name=w.png&${note}`)).body.path).toBe('Wiki/foo/w-2.png');
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(t, `name=z.png&${note}`, Buffer.from([i]))));
    expect(many.map((r) => r.status)).toEqual(Array(10).fill(201));
    const paths = many.map((r) => r.body.path as string);
    expect(new Set(paths).size).toBe(10);
    for (const [i, r] of many.entries()) expect([...(await readFile(join(t.vaults.vaultRootDir(t.id), r.body.path)))]).toEqual([i]);
  });

  it('upload: refusals', async () => {
    const t = await vaultApp({ 'Wiki/foo/foo.md': '# Foo\n', 'Other.md': 'other\n' });
    const note = 'note=Wiki/foo/foo.md';
    const files = async () => (await t.api.get(`/vaults/${t.id}/files`)).body.map((f: { path: string }) => f.path);
    const before = await files();
    for (const name of ['a.heic', 'a.svg']) expect((await upload(t, `name=${name}&${note}`)).body).toMatchObject({ code: 'not-uploadable' });
    expect((await upload(t, `name=a.heic&${note}`)).status).toBe(415);
    expect((await upload(t, `name=big.pdf&${note}`, Buffer.alloc(MAX_UPLOAD_BYTES + 1))).body).toMatchObject({ code: 'too-large' });
    for (const name of ['a|b.png', 'sub/a.png', '.a.png', 'opencode.json', 'a[1].png', 'a#b.png'])
      expect((await upload(t, `name=${encodeURIComponent(name)}&${note}`)).body, name).toMatchObject({ code: 'bad-name' });
    expect((await upload(t, 'name=a.png&note=../x.md')).body).toMatchObject({ code: 'bad-path' });
    expect((await upload(t, `name=a.png&${note}&source=new&at=2026-10-04-091500`)).status).toBe(400);
    expect((await upload(t, 'name=a.png')).status).toBe(400);
    const unauth = await request(t.app).post(`/api/vaults/${t.id}/raw?name=a.png&${note}`).set('Content-Type', 'application/octet-stream').send(Buffer.from([1]));
    expect(unauth.status).toBe(401);
    expect(await files()).toEqual(before);
    // The raw parser is scoped to the upload route: a 2 MB JSON save still works.
    expect((await t.api.put(`/vaults/${t.id}/file?path=Big.md`, { content: 'x'.repeat(2 * 1024 * 1024), version: null })).status).toBe(200);

    const f = (await t.api.get(`/vaults/${t.id}/file?path=Other.md`)).body;
    await t.api.put(`/vaults/${t.id}/file?path=Other.md`, { content: 'mine\n', version: f.version });
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n' });
    await t.api.post(`/vaults/${t.id}/commit`, { message: 'x' });
    expect((await t.api.get(`/vaults/${t.id}`)).body.state).toBe('conflict');
    expect((await upload(t, `name=c.png&${note}`)).status).toBe(423);
  });

  it('upload: flat page moves into its own folder', async () => {
    const t = await vaultApp({
      'Wiki/serien/foo.md': '# Foo\n',
      'bar.md': '# Bar\n',
      'Sources/x/x.md': '# X\n',
      'Sources/y/index.md': '# Y\n',
      'Wiki/Foo2/foo2.md': '# Foo2\n',
      'Wiki/imgs.md': '# Imgs\n',
      'Wiki/imgs/old.png': 'png',
      '.obsidian/app.json': '{"attachmentFolderPath":"Assets"}',
    });
    const root = t.vaults.vaultRootDir(t.id);
    const r = await upload(t, 'name=a.png&note=Wiki/serien/foo.md');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ path: 'Wiki/serien/foo/a.png', moved: { from: 'Wiki/serien/foo.md', to: 'Wiki/serien/foo/foo.md' } });
    await expect(readFile(join(root, 'Wiki/serien/foo.md'))).rejects.toThrow();
    expect(await readFile(join(root, 'Wiki/serien/foo/foo.md'), 'utf8')).toBe('# Foo\n');
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path)).toEqual(
      expect.arrayContaining(['Wiki/serien/foo.md', 'Wiki/serien/foo/foo.md', 'Wiki/serien/foo/a.png']),
    );
    expect((await upload(t, 'name=b.png&note=bar.md')).body).toMatchObject({ path: 'bar/b.png', moved: { from: 'bar.md', to: 'bar/bar.md' } });
    for (const [note, folder] of [['Sources/x/x.md', 'Sources/x'], ['Sources/y/index.md', 'Sources/y'], ['Wiki/Foo2/foo2.md', 'Wiki/Foo2']] as const) {
      const u = await upload(t, `name=${folder.split('/').pop()}-c.png&note=${note}`);
      expect(u.body.path, note).toMatch(new RegExp(`^${folder}/`));
      expect(u.body.moved, note).toBeUndefined();
    }
    // A folder of that name holding only images: the page moves in next to them.
    expect((await upload(t, 'name=d.png&note=Wiki/imgs.md')).body).toMatchObject({ path: 'Wiki/imgs/d.png', moved: { to: 'Wiki/imgs/imgs.md' } });
    expect(await readFile(join(root, 'Wiki/imgs/old.png'), 'utf8')).toBe('png');
  });

  it('upload: move refusals', async () => {
    const tree = async (t: { api: { get: (p: string) => request.Test }; id: string }) => (await t.api.get(`/vaults/${t.id}/files`)).body;
    for (const existing of ['Wiki/serien/foo/foo.md', 'Wiki/serien/foo/FOO.md']) {
      const t = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n', [existing]: 'there\n' });
      const before = await tree(t);
      const r = await upload(t, 'name=a.png&note=Wiki/serien/foo.md');
      expect(r.status, existing).toBe(409);
      expect(r.body.code, existing).toBe('folder-taken');
      expect(await tree(t)).toEqual(before);
    }
    const t = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n' });
    const before = await tree(t);
    const release = await t.vaults.lock(t.id).acquireShared('turn');
    try {
      const r = await upload(t, 'name=a.png&note=Wiki/serien/foo.md');
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'ai-busy', error: "The AI is working. Attach again when it's done." });
      // A page already in its own folder doesn't move, so it may get files during a turn.
    } finally {
      release();
    }
    expect(await tree(t)).toEqual(before);
  });

  it('upload: move rewrites path-form links', async () => {
    const files = { 'Wiki/serien/foo.md': '# Foo\n![](img/p.png)\n', 'Wiki/a.md': '[[serien/foo]] and [[foo]]', 'Wiki/b.md': '[[filme/foo]]', 'Wiki/filme/foo.md': 'film' };
    const t = await vaultApp(files);
    const root = t.vaults.vaultRootDir(t.id);
    await t.vaults.markAiTouched(t.id, ['Wiki/serien/foo.md']);
    const r = await upload(t, 'name=a.png&note=Wiki/serien/foo.md');
    expect(r.status).toBe(201);
    expect(r.body.rewritten).toEqual(['Wiki/a.md']);
    expect(await readFile(join(root, 'Wiki/a.md'), 'utf8')).toBe('[[serien/foo/foo]] and [[foo]]');
    expect(await readFile(join(root, 'Wiki/b.md'), 'utf8')).toBe('[[filme/foo]]');
    expect(await readFile(join(root, 'Wiki/serien/foo/foo.md'), 'utf8')).toBe('# Foo\n![](../img/p.png)\n');
    expect(t.vaults.aiTouched(t.id)).toEqual(['Wiki/serien/foo/foo.md']);

    // A page changed between the scan and the write: 409 stale, and the page stays where it was.
    const t2 = await vaultApp(files);
    const root2 = t2.vaults.vaultRootDir(t2.id);
    t2.vaults.afterRelinkScan = () => writeFile(join(root2, 'Wiki/a.md'), 'edited meanwhile [[serien/foo]]');
    const s = await upload(t2, 'name=a.png&note=Wiki/serien/foo.md');
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('stale');
    expect(await readFile(join(root2, 'Wiki/serien/foo.md'), 'utf8')).toBe('# Foo\n![](img/p.png)\n');
    expect(await readFile(join(root2, 'Wiki/a.md'), 'utf8')).toBe('edited meanwhile [[serien/foo]]');
  });

  it('upload: the note must be an existing page outside hidden and harness folders', async () => {
    const t = await vaultApp({ 'Wiki/foo/foo.md': '# Foo\n', 'Wiki/pic.png': 'png', 'notes.txt': 'n' });
    const files = async () => (await t.api.get(`/vaults/${t.id}/files`)).body.map((f: { path: string }) => f.path);
    const before = await files();
    const { readdir } = await import('node:fs/promises');
    const rootBefore = await readdir(t.vaults.vaultRootDir(t.id));
    for (const note of ['.opencode/index.md', 'opencode.json/index.md', '.obsidian/index.md', 'Wiki/.hidden/x.md', 'Wiki/missing/missing.md', 'Sources/x/index.md', 'Wiki/pic.png', 'notes.txt', 'Wiki/a|b/a|b.md']) {
      const r = await upload(t, `name=a.png&note=${encodeURIComponent(note)}`);
      expect(r.status, note).toBeGreaterThanOrEqual(400);
      expect(r.status, note).toBeLessThan(500);
    }
    expect(await files()).toEqual(before);
    expect(await readdir(t.vaults.vaultRootDir(t.id))).toEqual(rootBefore);
    expect(t.vaults.harnessConfigIn(t.id)).toBeNull();
  });

  it('upload: the move checks everything before its first write', async () => {
    // dir/stem is a file: refused, and no link was rewritten.
    const a = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n', 'Wiki/serien/foo': 'a file', 'Wiki/a.md': '[[serien/foo]]' });
    const ra = await upload(a, 'name=a.png&note=Wiki/serien/foo.md');
    expect(ra.body).toMatchObject({ code: 'folder-taken' });
    expect(await readFile(join(a.vaults.vaultRootDir(a.id), 'Wiki/a.md'), 'utf8')).toBe('[[serien/foo]]');
    expect(await readFile(join(a.vaults.vaultRootDir(a.id), 'Wiki/serien/foo.md'), 'utf8')).toBe('# Foo\n');

    // A folder of that name in other case: the page moves into it, keeping its spelling (no case twin).
    const b = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n', 'Wiki/serien/Foo/x.png': 'x' });
    const rb = await upload(b, 'name=a.png&note=Wiki/serien/foo.md');
    expect(rb.body).toMatchObject({ path: 'Wiki/serien/Foo/a.png', moved: { to: 'Wiki/serien/Foo/foo.md' } });
    expect((await b.api.get(`/vaults/${b.id}/files`)).body.map((f: { path: string }) => f.path).filter((p: string) => p.startsWith('Wiki/serien/'))).toEqual(
      ['Wiki/serien/Foo', 'Wiki/serien/Foo/a.png', 'Wiki/serien/Foo/foo.md', 'Wiki/serien/Foo/x.png']);

    // The page itself changes during the move: 409 stale, the edit stays at the old path, nothing else changed.
    const c = await vaultApp({ 'Wiki/serien/foo.md': '# Foo\n', 'Wiki/a.md': '[[serien/foo]]' });
    const root = c.vaults.vaultRootDir(c.id);
    c.vaults.afterRelinkScan = () => writeFile(join(root, 'Wiki/serien/foo.md'), '# Foo edited\n');
    const rc = await upload(c, 'name=a.png&note=Wiki/serien/foo.md');
    expect(rc.body).toMatchObject({ code: 'stale' });
    expect(await readFile(join(root, 'Wiki/serien/foo.md'), 'utf8')).toBe('# Foo edited\n');
    expect(await readFile(join(root, 'Wiki/a.md'), 'utf8')).toBe('[[serien/foo]]');
    expect((await c.api.get(`/vaults/${c.id}/files`)).body.map((f: { path: string }) => f.path).filter((p: string) => p.includes('a.png'))).toEqual([]);
  });

  it('upload: the move finds percent-encoded links to a page with umlauts', async () => {
    const t = await vaultApp({ 'Wiki/serien/München.md': '# München\n', 'Wiki/a.md': '[M](serien/M%C3%BCnchen.md)' });
    const r = await upload(t, `name=a.png&note=${encodeURIComponent('Wiki/serien/München.md')}`);
    expect(r.body).toMatchObject({ moved: { to: 'Wiki/serien/München/München.md' }, rewritten: ['Wiki/a.md'] });
    expect(await readFile(join(t.vaults.vaultRootDir(t.id), 'Wiki/a.md'), 'utf8')).toBe('[M](serien/M%C3%BCnchen/M%C3%BCnchen.md)');
  });

  it('upload: source folders', async () => {
    const t = await vaultApp({ 'Sources/mail-x/mail-x.md': '# Mail\n' });
    const at = 'at=2026-10-04-091500';
    expect((await upload(t, `name=photo.jpg&source=new&${at}`)).body).toMatchObject({ path: 'Sources/upload-2026-10-04-091500/photo.jpg' });
    expect((await upload(t, 'name=doc.pdf&source=upload-2026-10-04-091500')).body).toMatchObject({ path: 'Sources/upload-2026-10-04-091500/doc.pdf' });
    expect((await upload(t, `name=x.jpg&source=new&${at}`)).body).toMatchObject({ path: 'Sources/upload-2026-10-04-091500-2/x.jpg' });
    for (const q of ['source=new', 'source=new&at=yesterday', 'source=new&at=../x'])
      expect((await upload(t, `name=y.jpg&${q}`)).status, q).toBe(400);
    for (const source of ['../Wiki', 'mail-x', 'upload-missing'])
      expect((await upload(t, `name=y.jpg&source=${encodeURIComponent(source)}`)).body, source).toMatchObject({ code: 'bad-path' });
    expect((await t.api.get(`/vaults/${t.id}/files`)).body.map((f: { path: string }) => f.path).filter((p: string) => p.includes('y.jpg'))).toEqual([]);

    // A vault with sources/ (lower case) keeps its spelling: no Sources/ twin.
    const l = await vaultApp({ 'sources/a/a.md': '# A\n', 'Wiki/w.md': 'w' });
    expect((await upload(l, `name=p.jpg&source=new&${at}`)).body).toMatchObject({ path: 'sources/upload-2026-10-04-091500/p.jpg' });
    expect(await readdir(l.vaults.vaultRootDir(l.id))).not.toContain('Sources');
  });
});

describe('open waits for a command-list refresh', () => {
  it('a refresh holding the lock delays the open pull instead of skipping it', async () => {
    const t = await vaultApp({ 'Home.md': '# Home\n', 'CLAUDE.md': '# Rules\n' });
    await t.remote.obsidianPush({ 'Other.md': 'pushed\n' });
    const release = t.vaults.lock(t.id).tryShared('refresh')!;
    setTimeout(release, 500);
    const st = await t.vaults.open(t.id);
    expect(st.incomingCount).toBe(0);
    expect(await readFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'utf8')).toBe('pushed\n');
  });
});

describe('agents move', () => {
  const legacy = { 'Home.md': '# Home\n', 'CLAUDE.md': '# Rules\n', '.claude/skills/x/SKILL.md': '---\nname: x\ndescription: X\n---\nDo x.\n' };
  const isMove = (e: VaultEvent) => e.type === 'agents-move';

  it('on open', async () => {
    const t = await vaultApp(legacy);
    const connect = await eventStreams(t.app);
    const s = await connect(t.id);
    await t.api.post(`/vaults/${t.id}/open`);
    await s.waitFor(isMove, 3000);
    expect(s.events.find(isMove)).toMatchObject({ type: 'agents-move', moved: ['x'], instructions: true });
    const paths = (await t.api.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path);
    expect(paths).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', '.agents/skills/x/SKILL.md', '.claude/skills']));
    await s.close();
  });

  it('after a pull', async () => {
    const t = await vaultApp(legacy);
    const connect = await eventStreams(t.app);
    const s = await connect(t.id);
    await t.api.post(`/vaults/${t.id}/open`);
    await s.waitFor(isMove, 3000);
    await t.remote.obsidianPush({ '.claude/commands/y.md': 'Do y.\n' });
    await t.api.post(`/vaults/${t.id}/pull`);
    await s.waitFor(() => s.events.filter(isMove).length === 2, 3000);
    expect(s.events.filter(isMove)[1]).toMatchObject({ converted: ['y'] });
    expect(await readFile(join(t.vaults.vaultRootDir(t.id), '.agents/skills/y/SKILL.md'), 'utf8')).toContain('name: y');
    // The pull's stash dropped the staged link; it is staged again.
    expect(sh(t.vaults.vaultRootDir(t.id), 'ls-files', '-s', '.claude/skills')).toMatch(/^120000 /);
    await s.close();
  });

  it('not in conflict', async () => {
    const t = await vaultApp({ 'Home.md': '# Home\n', 'Other.md': 'other\n' });
    await writeFile(join(t.vaults.vaultRootDir(t.id), 'Other.md'), 'mine\n');
    await t.remote.obsidianPush({ 'Other.md': 'theirs\n', 'CLAUDE.md': '# Rules\n' });
    expect((await t.api.post(`/vaults/${t.id}/pull`)).body.state).toBe('conflict');
    const connect = await eventStreams(t.app);
    const s = await connect(t.id);
    await t.api.post(`/vaults/${t.id}/open`);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.events.filter(isMove)).toEqual([]);
    expect(await readFile(join(t.vaults.vaultRootDir(t.id), 'AGENTS.md'), 'utf8').catch(() => null)).toBeNull();
    await s.close();
  });

  it('a clash is reported once', async () => {
    const t = await vaultApp({ ...legacy, '.agents/skills/x/SKILL.md': 'NEW\n' });
    const connect = await eventStreams(t.app);
    const s = await connect(t.id);
    await t.api.post(`/vaults/${t.id}/open`);
    await s.waitFor(isMove, 3000);
    expect(s.events.find(isMove)).toMatchObject({ skipped: ['x'] });
    await t.api.post(`/vaults/${t.id}/pull`);
    await new Promise((r) => setTimeout(r, 300));
    expect(s.events.filter(isMove)).toHaveLength(1);
    await s.close();
  });

  for (const order of ['listed', 'reverse'] as const) {
    it(`discard undoes the move (${order} order)`, async () => {
      const t = await vaultApp(legacy);
      await t.api.post(`/vaults/${t.id}/open`);
      const changes = (await t.api.get(`/vaults/${t.id}/changes`)).body as { path: string; version: string | null }[];
      // Reverse: the deleted skill file comes back while the link stub is still there.
      if (order === 'reverse') changes.reverse();
      for (const c of changes) expect((await t.api.post(`/vaults/${t.id}/discard?path=${encodeURIComponent(c.path)}`)).status).toBe(204);
      const root = t.vaults.vaultRootDir(t.id);
      expect(await readFile(join(root, '.claude/skills/x/SKILL.md'), 'utf8')).toContain('name: x');
      expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Rules\n');
      expect(await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => null)).toBeNull();
      expect(sh(root, 'ls-files', '-s', '.claude/skills')).not.toMatch(/^120000/m);
      expect((await t.api.get(`/vaults/${t.id}/changes`)).body).toEqual([]);
    });
  }
});
