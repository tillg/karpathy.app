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
    // Opaque (#141 review): a keyed hash of file, rule and secret, not `file:rule:line`.
    expect(f!.fingerprint).toMatch(/^[0-9a-f]{32}$/);
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

  it("honours the vault's committed .gitleaksignore, but not inline gitleaks:allow or a vault .gitleaks.toml", async () => {
    const t = await vaultApp({}, { 'Home.md': '# Home\n', '.gitleaksignore': 'Known.md:github-pat:1\n' });
    await writeFile(join(t.root, 'Known.md'), `${fakeToken()}\n`);
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

describe('secret scan review fixes (#141)', () => {
  async function stagedRepo(files: Record<string, string | Buffer>) {
    const dir = await mkdtemp(join(tmpdir(), 'kai-scan-'));
    sh(dir, 'init', '-q', '-b', 'main');
    for (const [p, c] of Object.entries(files)) await writeFile(join(dir, p), c);
    sh(dir, 'add', '-A');
    return dir;
  }

  it('finds a token in a file git treats as binary (a NUL byte)', async () => {
    const dir = await stagedRepo({ 'note.md': Buffer.concat([Buffer.from('x\0y\n'), Buffer.from(`key ${fakeToken()}\n`)]) });
    expect((await new SecretScanner().scanStaged(dir)).map((f) => [f.file, f.line, f.rule])).toEqual([['note.md', 2, 'github-pat']]);
  });

  it('finds a token behind a -diff attribute in a staged .gitattributes', async () => {
    const dir = await stagedRepo({ '.gitattributes': '*.md -diff\n', 'note.md': `key ${fakeToken()}\n` });
    expect((await new SecretScanner().scanStaged(dir)).map((f) => f.file)).toEqual(['note.md']);
  });

  it('does not report a secret the modified file already had (only new ones)', async () => {
    const old = fakeToken();
    const dir = await stagedRepo({ 'note.md': `a ${old}\n` });
    sh(dir, 'commit', '-q', '-m', 'old');
    await writeFile(join(dir, 'note.md'), `intro\na ${old}\n`);
    sh(dir, 'add', '-A');
    expect(await new SecretScanner().scanStaged(dir)).toEqual([]);
    await writeFile(join(dir, 'note.md'), `intro\na ${old}\nb ${fakeToken()}\n`);
    sh(dir, 'add', '-A');
    expect((await new SecretScanner().scanStaged(dir)).map((f) => f.line)).toEqual([3]);
  });

  it('a renamed file with an old secret is not reported again', async () => {
    const dir = await stagedRepo({ 'a.md': `some text that stays the same\nkey ${fakeToken()}\nmore text\n` });
    sh(dir, 'commit', '-q', '-m', 'old');
    sh(dir, 'mv', 'a.md', 'b.md');
    expect(await new SecretScanner().scanStaged(dir)).toEqual([]);
  });

  it('a changed file over the size cap is a finding, not a silent skip', async () => {
    const dir = await stagedRepo({ 'big.bin': Buffer.alloc(2048, 1) });
    const [f, ...rest] = await new SecretScanner({ maxBytes: 1024 }).scanStaged(dir);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ file: 'big.bin', rule: 'too-large-to-scan', line: 0 });
  });

  it('scans the commit message', async () => {
    const dir = await stagedRepo({ 'note.md': 'clean\n' });
    const findings = await new SecretScanner().scanStaged(dir, { message: `Add note\n\nwith ${fakeToken()}\n` });
    expect(findings.map((f) => [f.file, f.line, f.rule])).toEqual([['Commit message', 3, 'github-pat']]);
  });

  it('fails closed when gitleaks logs an error but still reports no leaks', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'kai-fake-gitleaks-'));
    const bin = join(binDir, 'gitleaks');
    await writeFile(bin, '#!/bin/sh\necho "10:00PM ERR failed to scan" >&2\necho "[]"\nexit 0\n', { mode: 0o755 });
    const dir = await stagedRepo({ 'note.md': 'clean\n' });
    await expect(new SecretScanner({ bin }).scanStaged(dir)).rejects.toThrow(/secret scan failed: .*ERR/);
  });

  it('fails closed when gitleaks skips a file', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'kai-fake-gitleaks-'));
    const bin = join(binDir, 'gitleaks');
    await writeFile(bin, '#!/bin/sh\necho "10:00PM WRN skipping file: permission denied path=x" >&2\necho "[]"\nexit 0\n', { mode: 0o755 });
    const dir = await stagedRepo({ 'note.md': 'clean\n' });
    await expect(new SecretScanner({ bin }).scanStaged(dir)).rejects.toThrow(/secret scan failed/);
  });

  it('commit: a .gitleaksignore written in the same commit does not allow its own finding', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Known.md'), `${fakeToken()}\n`);
    await writeFile(join(t.root, '.gitleaksignore'), 'Known.md:github-pat:1\n');
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'known' });
    expect(r.status).toBe(422);
    expect(r.body.findings.map((f: { file: string }) => f.file)).toEqual(['Known.md']);
    expect(t.remote.remoteLog()).toEqual(['seed']);
  });

  it('commit: a token in the commit message blocks the commit', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Note.md'), 'clean\n');
    const token = fakeToken();
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: `Note\n\n${token}` });
    expect(r.status).toBe(422);
    expect(r.body.findings).toEqual([expect.objectContaining({ file: 'Commit message', line: 3, rule: 'github-pat' })]);
    expect(JSON.stringify(r.body)).not.toContain(token.slice(4));
    expect(t.remote.remoteLog()).toEqual(['seed']);
  });

  it('"commit anyway" does not cover a different secret of the same rule on the same line', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    const blocked = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    const allow = blocked.body.findings.map((f: { fingerprint: string }) => f.fingerprint);
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak', allowSecrets: allow });
    expect(r.status).toBe(422);
    expect(t.remote.remoteLog()).toEqual(['seed']);
  });

  it('push: an unscanned local commit with a secret is not pushed; its changes come back as uncommitted', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    sh(t.root, 'add', '-A');
    sh(t.root, 'commit', '-q', '-m', 'outside the app');
    const r = await t.api.post(`/vaults/${t.id}/push`);
    expect(r.status).toBe(200);
    expect(r.body.pushed).toBe(false);
    expect(r.body.pushError).toMatch(/possible secret/i);
    expect(t.remote.remoteLog()).toEqual(['seed']);
    expect((await t.api.get(`/vaults/${t.id}/changes`)).body.map((c: { path: string }) => c.path)).toEqual(['Leak.md']);
    // The normal commit then scans it, with "commit anyway" available.
    expect((await t.api.post(`/vaults/${t.id}/commit`, { message: 'again' })).status).toBe(422);
  });

  it('push: an unscanned clean local commit is pushed', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Clean.md'), 'clean\n');
    sh(t.root, 'add', '-A');
    sh(t.root, 'commit', '-q', '-m', 'outside the app');
    const r = await t.api.post(`/vaults/${t.id}/push`);
    expect(r.body.pushed).toBe(true);
    expect(t.remote.remoteLog()[0]).toBe('outside the app');
  });

  it('push: an acknowledged app commit whose push failed is pushed later without a new prompt', async () => {
    const t = await vaultApp();
    await writeFile(join(t.root, 'Leak.md'), `${fakeToken()}\n`);
    const blocked = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak' });
    const allow = blocked.body.findings.map((f: { fingerprint: string }) => f.fingerprint);
    const remoteUrl = sh(t.root, 'remote', 'get-url', 'origin').trim();
    sh(t.root, 'remote', 'set-url', 'origin', '/nonexistent/remote.git');
    const r = await t.api.post(`/vaults/${t.id}/commit`, { message: 'leak', allowSecrets: allow });
    expect(r.status).toBe(200);
    expect(r.body.pushed).toBe(false);
    sh(t.root, 'remote', 'set-url', 'origin', remoteUrl);
    const p = await t.api.post(`/vaults/${t.id}/push`);
    expect(p.body.pushed).toBe(true);
    expect(t.remote.remoteLog()[0]).toBe('leak');
  });
});

describe('commit message proposal (#167)', () => {
  it('takes possible secrets out of the diff it sends to the model', async () => {
    const { OpencodeCommitMessages } = await import('../src/commit-message.js');
    const t = await vaultApp();
    const token = fakeToken();
    await writeFile(join(t.root, 'Leak.md'), `# Mail\n\nlogin with ${token} please\n`);
    const sent: string[] = [];
    const harness = {
      createSession: async () => 's1',
      promptSync: async (_dir: string, _id: string, p: { text: string }) => { sent.push(p.text); return 'Add mail'; },
      abort: async () => undefined,
      deleteSession: async () => undefined,
    };
    const cm = new OpencodeCommitMessages(t.vaults, t.store, harness as never, () => t.root, 5000);
    expect(await cm.propose(t.id)).toEqual({ message: 'Add mail', fallback: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('login with');
    expect(sent[0]).not.toContain(token.slice(4));
    // The index is not touched: the file is still untracked.
    expect(sh(t.root, 'status', '--porcelain')).toContain('?? Leak.md');
  });
});
