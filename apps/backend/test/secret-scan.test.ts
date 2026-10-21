import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeApp } from './app-helpers.js';
import { makeRemote, sh, writeFiles } from './helpers.js';
import { SecretScanner } from '../src/secret-scan.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * A fresh fake GitHub token per call, built at runtime: the repo's own secret scan must not find one in this
 * file. The random part makes it high-entropy, as gitleaks' rule wants.
 */
function fakeToken(): string {
  let s = '';
  while (s.length < 36) s += randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return ['gh', 'p_'].join('') + s.slice(0, 36);
}

async function vaultApp(more: object = {}, files: Record<string, string> = { 'Home.md': '# Home\n' }) {
  const remote = await makeRemote(files);
  const t = await makeApp(remote.remoteBase);
  cleanups.push(() => t.vaults.close());
  const id = await t.addVault(remote.repo, more);
  return { ...t, remote, id, root: t.vaults.vaultRootDir(id) };
}

describe('SecretScanner.scanStaged', () => {
  it('finds a token in the staged changes: file, line, rule, a masked hint; never the secret itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kai-scan-'));
    sh(dir, 'init', '-q', '-b', 'main');
    const token = fakeToken();
    await writeFiles(dir, { 'notes/a note.md': `line 1\nline 2\nmy token: ${token}\n` });
    sh(dir, 'add', '-A');
    const findings = await new SecretScanner().scanStaged(dir);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f).toMatchObject({ file: 'notes/a note.md', line: 3, rule: 'github-pat' });
    expect(f!.masked).toMatch(/^.{1,4}…$/);
    expect(token.startsWith(f!.masked.slice(0, -1))).toBe(true);
    expect(f!.fingerprint).toBe('notes/a note.md:github-pat:3');
    expect(JSON.stringify(findings)).not.toContain(token.slice(4));
  });

  it('nothing staged → no findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kai-scan-'));
    sh(dir, 'init', '-q', '-b', 'main');
    await writeFile(join(dir, 'x.md'), `unstaged ${fakeToken()}\n`);
    expect(await new SecretScanner().scanStaged(dir)).toEqual([]);
  });

  it('fails (instead of reporting a clean diff) when gitleaks is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kai-scan-'));
    sh(dir, 'init', '-q', '-b', 'main');
    await expect(new SecretScanner({ bin: 'no-such-gitleaks' }).scanStaged(dir)).rejects.toThrow(/secret scan/i);
  });
});

describe('commit: secret scan (#141)', () => {
  it('blocks the commit with file, line and rule; nothing is committed or pushed', async () => {
    const t = await vaultApp();
    const token = fakeToken();
    await writeFile(join(t.root, 'Leak.md'), `# Mail\n\nhttps://example.com/?x=1\nkey ${token}\n`);
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('secrets');
    expect(r.body.error).toMatch(/Leak\.md.*line 4.*github-pat/);
    expect(r.body.findings).toEqual([expect.objectContaining({ file: 'Leak.md', line: 4, rule: 'github-pat' })]);
    expect(JSON.stringify(r.body)).not.toContain(token.slice(4));
    expect(t.remote.remoteLog()).toEqual(['seed']);
    // Still an uncommitted change: the user can fix or discard it.
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path)).toEqual(['Leak.md']);
  });

  it('reports vault paths when the vault has a root folder', async () => {
    const remote = await makeRemote({ 'wiki/Home.md': '# Home\n', 'wiki/Sources/.gitkeep': '', 'wiki/Wiki/.gitkeep': '' }, { structure: false });
    const t = await makeApp(remote.remoteBase);
    cleanups.push(() => t.vaults.close());
    const id = await t.addVault(remote.repo, { root: 'wiki' });
    await writeFile(join(t.vaults.vaultRootDir(id), 'Leak.md'), `${fakeToken()}\n`);
    const r = await t.api.post(`/vaults/${id}/commit`, { message: 'leak' });
    expect(r.status).toBe(422);
    expect(r.body.findings[0]).toMatchObject({ file: 'Leak.md', line: 1 });
  });

  it('"commit anyway" with the findings it was shown commits and pushes', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    const blocked = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    const allow = blocked.body.findings.map((f: { fingerprint: string }) => f.fingerprint);
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak', allowSecrets: allow });
    expect(r.status).toBe(200);
    expect(r.body.pushed).toBe(true);
    expect(t.remote.remoteLog()[0]).toBe('leak');
  });

  it('"commit anyway" does not cover a secret that arrived after the user looked', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    const blocked = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    const allow = blocked.body.findings.map((f: { fingerprint: string }) => f.fingerprint);
    await writeFile(join(t.root, 'Other.md'), `${fakeToken()}\n`);
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak', allowSecrets: allow });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: { file: string }) => f.file)).toEqual(['Other.md']);
    expect(t.remote.remoteLog()).toEqual(['seed']);
  });

  it("honours the vault's .gitleaksignore, but not inline gitleaks:allow or a vault .gitleaks.toml", async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Known.md'), `${fakeToken()}\n`);
    await writeFile(join(t.root, '.gitleaksignore'), 'Known.md:github-pat:1\n');
    expect((await t.api.post(`/vaults/${t.id}/commit`, { message: 'known' })).status).toBe(200);

    // A mail could carry the marker; a file in the vault must not switch the rules off.
    await writeFile(join(t.root, 'Inline.md'), `${fakeToken()} gitleaks:allow\n`);
    await writeFile(join(t.root, '.gitleaks.toml'), '[allowlist]\npaths = [".*"]\n');
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'inline' });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: { file: string }) => f.file)).toEqual(['Inline.md']);
  });

  it('a commit without secrets is not affected', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Note.md'), 'token: see the password manager\n');
    expect((await t.api.post(`/vaults/${t.id}/commit`, { message: 'clean' })).status).toBe(200);
    expect(t.remote.remoteLog()[0]).toBe('clean');
  });
});
