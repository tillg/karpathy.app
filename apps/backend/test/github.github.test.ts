import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config-store.js';
import { Git } from '../src/git.js';
import { GitHubToken } from '../src/github-token.js';
import { Vaults } from '../src/vaults.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { identity } from './helpers.js';

// @github tier: the throwaway test vault on GitHub, never the real life wiki.
const REPO = process.env.TEST_VAULT_REPO ?? 'tillg/karpathy-app-test-vault';
const token = process.env.TEST_VAULT_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const branch = `test-${Date.now()}`;

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'kai-gh-'));
  const store = await ConfigStore.open(join(base, 'config'));
  const vaults = new Vaults(store, { vaultsDir: join(base, 'vaults'), remoteBase: 'https://github.com/', githubToken: () => token, identity });
  await vaults.init();
  return { vaults, base };
}

const pushed: { dir: string }[] = [];
afterAll(async () => {
  // Remove the temporary branch from the test repo.
  for (const p of pushed) {
    execFileSync('git', ['init', '-q'], { cwd: p.dir }); // push needs a repo to run in
    await new Git(p.dir, { identity, token }).run(['push', '-q', `https://github.com/${REPO}.git`, '--delete', branch], { allowFail: true });
  }
});

describe('@github test vault', () => {
  it('clones the repo root and the wiki/ subfolder variant with the token', async () => {
    const { vaults } = await setup();
    const a = await vaults.add({ name: 'root', repo: REPO });
    const b = await vaults.add({ name: 'sub', repo: REPO, root: 'wiki' });
    await vaults.whenCloned(a.id);
    await vaults.whenCloned(b.id);
    expect(vaults.getVault(a.id).state).toBe('ready');
    expect((await vaults.listFiles(a.id)).map((f) => f.path)).toEqual(expect.arrayContaining(['README.md', 'Note A.md', 'wiki/Home.md']));
    expect((await vaults.listFiles(b.id)).map((f) => f.path)).toEqual(['Home.md', 'Page.md', 'Sources', 'Wiki']);
    // The token is never written to .git/config.
    const cfg = execFileSync('git', ['config', '--list', '--local'], { cwd: vaults.vaultRootDir(a.id), encoding: 'utf8' });
    expect(cfg).not.toContain(token);
    await vaults.close();
  });

  it('token changed at runtime is used by the next clone', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kai-gh-'));
    const store = await ConfigStore.open(join(base, 'config'));
    const gh = new GitHubToken(store, 'ghp_wrongwrongwrongwrongwrongwrong');
    const vaults = new Vaults(store, { vaultsDir: join(base, 'vaults'), remoteBase: 'https://github.com/', githubToken: () => gh.current(), identity });
    await vaults.init();
    const bad = await vaults.add({ name: 'before', repo: REPO }).catch(() => null);
    if (bad) {
      await vaults.whenCloned(bad.id);
      expect(vaults.getVault(bad.id).state).toBe('clone-failed');
      await vaults.remove(bad.id);
    }
    await gh.set(token);
    const good = await vaults.add({ name: 'after', repo: REPO });
    await vaults.whenCloned(good.id);
    expect(vaults.getVault(good.id).state).toBe('ready');
    await vaults.close();
  });

  it('token test: valid token → ok with login and vault reachable; garbage token → 401', async () => {
    const remote = 'https://github.com/';
    const base = await mkdtemp(join(tmpdir(), 'kai-gh-'));
    const { makeApp } = await import('./app-helpers.js');
    const t = await makeApp(remote, { dirs: { config: join(base, 'config'), vaults: join(base, 'vaults') }, githubSecret: token });
    const v = await t.vaults.add({ name: 'tt', repo: REPO });
    await t.vaults.whenCloned(v.id);
    const good = await t.api.post('/settings/github-token/test', {});
    expect(good.body).toMatchObject({ ok: true, login: expect.any(String), vaults: [{ repo: REPO, ok: true }] });
    const bad = await t.api.post('/settings/github-token/test', { token: 'ghp_garbagegarbagegarbagegarbage00' });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/401/);
    expect(bad.body.vaults[0].ok).toBe(false);
    expect(bad.text).not.toContain(token);
    await t.vaults.close();
  });

  it('bad repo → 422 at add with the git error, token redacted, nothing stored', async () => {
    const { vaults } = await setup();
    const err = await vaults.add({ name: 'bad', repo: 'tillg/karpathy-app-no-such-repo' }).catch((e: Error & { status?: number; code?: string }) => e);
    expect(err).toMatchObject({ status: 422, code: 'repo-unreachable' });
    expect((err as Error).message).toBeTruthy();
    expect((err as Error).message).not.toContain(token);
    expect(vaults.list()).toEqual([]);
  });

  it('commit + push round trip on a temporary branch; DELETE never touches the remote', async () => {
    const { vaults, base } = await setup();
    const v = await vaults.add({ name: 'rt', repo: REPO });
    await vaults.whenCloned(v.id);
    const dir = vaults.vaultRootDir(v.id);
    const git = new Git(dir, { identity, token });
    await git.run(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    pushed.push({ dir: base });
    await vaults.patch(v.id, { branch });
    await writeFile(join(dir, 'roundtrip.md'), `written at ${new Date().toISOString()}\n`);
    const r = await vaults.commit(v.id, 'Round trip test');
    expect(r.pushed).toBe(true);
    const remote = (await git.out(['ls-remote', 'origin', `refs/heads/${branch}`])).split('\t')[0];
    expect(remote).toBe(r.commit);
    await vaults.remove(v.id);
    const outside = new Git(base, { identity, token });
    expect((await outside.run(['ls-remote', '--exit-code', `https://github.com/${REPO}.git`, branch], { allowFail: true })).code).toBe(0);
    await vaults.close();
  });
});
