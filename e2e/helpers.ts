import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, request, type APIRequestContext, type Page } from '@playwright/test';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Defaults target the dev stack; override to run against another stack (e.g. deploy/compose.prodtest.yml). */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
export const TOKEN = readFileSync(resolve(ROOT, process.env.E2E_TOKEN_FILE ?? 'deploy/secrets/bearer_token'), 'utf8').trim();
/**
 * Runs a command in the target stack's backend container. Defaults to the dev stack; another stack
 * sets E2E_BACKEND_CONTAINER, and one on another Docker daemon E2E_DOCKER (e.g. `limactl shell karpathy-vm sudo docker`).
 */
export function backendExec(...args: string[]): string {
  const [cmd, ...pre] = (process.env.E2E_DOCKER ?? 'docker').split(' ');
  const container = process.env.E2E_BACKEND_CONTAINER ?? 'karpathy-app-backend-1';
  return execFileSync(cmd, [...pre, 'exec', container, ...args], { encoding: 'utf8' });
}
/** Host dir mounted as /remotes in the backend (GIT_REMOTE_BASE=file:///remotes/). */
export const REMOTES = join(ROOT, 'tmp/dev/remotes/e2e');

/** Set once per `playwright test` run (global setup) and inherited by the workers; tags this run's vaults. */
export const runId = () => process.env.E2E_RUN_ID ?? 'adhoc';
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Obsidian', '-c', 'user.email=obsidian@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

function chmodAll(p: string) {
  chmodSync(p, 0o777);
  if (statSync(p).isDirectory()) for (const e of readdirSync(p)) chmodAll(join(p, e));
}

/** Bare repo tmp/dev/remotes/e2e/<name>.git seeded by make-vault.py (Home.md, Ideas.md, AGENTS.md, CLAUDE.md, a `hello` skill, n notes). */
export function makeRemote(name: string, notes = 6): string {
  const bare = join(REMOTES, `${name}.git`);
  execFileSync('python3', [join(ROOT, 'e2e/fixtures/make-vault.py'), bare, String(notes)], { cwd: ROOT });
  // The backend container writes as uid 1000, the host as the current user: keep it world-writable.
  git(bare, 'config', 'core.sharedRepository', '0666');
  chmodAll(bare);
  return bare;
}

/** A bare repo under REMOTES with one note and none of the required folders. */
export function makePlainRemote(name: string) {
  const bare = join(REMOTES, `${name}.git`);
  const work = mkdtempSync(join(tmpdir(), 'e2e-plain-'));
  try {
    git(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'Home.md'), '# Home\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'seed');
    mkdirSync(REMOTES, { recursive: true });
    git(REMOTES, 'clone', '-q', '--bare', work, bare);
    // The backend container writes as uid 1000, the host as the current user: keep it world-writable.
    git(bare, 'config', 'core.sharedRepository', '0666');
    chmodAll(bare);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bare;
}

export function remoteLog(bare: string, format = '%s'): string[] {
  return git(bare, 'log', 'main', `--format=${format}`).split('\n');
}

export function remoteShow(bare: string, path: string): string {
  return git(bare, 'show', `main:${path}`);
}

/** Simulates Obsidian: clone the bare repo on the host, change a file, commit, push. */
export function pushFromObsidian(bare: string, path: string, content: string | Buffer, message = 'Edit from Obsidian') {
  const work = mkdtempSync(join(tmpdir(), 'e2e-obsidian-'));
  try {
    git(work, 'clone', '-q', bare, '.');
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', message);
    git(work, 'push', '-q', 'origin', 'main');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  chmodAll(bare);
}

/** Makes the remote unreachable (push fails) and returns a function that restores it. */
export function breakRemote(bare: string): () => void {
  const off = `${bare}.off`;
  renameSync(bare, off);
  return () => {
    renameSync(off, bare);
    chmodAll(bare);
  };
}

export class Api {
  constructor(readonly ctx: APIRequestContext) {}

  static async create(): Promise<Api> {
    return new Api(await request.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } }));
  }

  private async json<T>(method: string, url: string, data?: unknown): Promise<T> {
    const res = await this.ctx.fetch(`/api${url}`, { method, data });
    if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${await res.text()}`);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  }

  vaults = () => this.json<{ id: string; name: string; repo: string; state: string; error?: string }[]>('GET', '/vaults');
  vault = (id: string) => this.json<{ id: string; name: string; state: string; error?: string }>('GET', `/vaults/${id}`);
  addVault = (name: string, repo: string) => this.json<{ id: string }>('POST', '/vaults', { name, repo });
  status = (id: string) => this.json<{ state: string; changedCount: number; unpushedCount: number; conflictPaths: string[] }>('GET', `/vaults/${id}/status`);
  files = (id: string) => this.json<{ path: string; type: string }[]>('GET', `/vaults/${id}/files`);
  changes = (id: string) => this.json<{ path: string; kind: string }[]>('GET', `/vaults/${id}/changes`);
  diff = (id: string, path: string) => this.json<{ diff: string }>('GET', `/vaults/${id}/changes/diff?path=${encodeURIComponent(path)}`);
  settings = () => this.json<{ commitReminderThreshold: number; model: string; webAccess: boolean }>('GET', '/settings');
  patchSettings = (s: { commitReminderThreshold?: number; webAccess?: boolean }) => this.json('PATCH', '/settings', s);

  async file(id: string, path: string): Promise<{ content: string; version: string } | null> {
    const res = await this.ctx.get(`/api/vaults/${id}/file?path=${encodeURIComponent(path)}`);
    if (res.status() === 404) return null;
    if (!res.ok()) throw new Error(`GET file ${path} → ${res.status()}`);
    return res.json();
  }

  /** Writes a file "behind the editor's back" (like the AI or another device would). */
  async write(id: string, path: string, content: string) {
    const cur = await this.file(id, path);
    return this.json<{ version: string }>('PUT', `/vaults/${id}/file?path=${encodeURIComponent(path)}`, { content, version: cur?.version ?? null });
  }

  async waitReady(id: string, timeout = 60_000) {
    await expect.poll(async () => (await this.vault(id)).state, { timeout, message: `vault ${id} ready` }).toBe('ready');
  }

  /** Creates a fresh remote + vault and waits for the clone. */
  async createVault(prefix: string, notes = 6): Promise<{ id: string; name: string; bare: string }> {
    // Slug-safe, so the vault id equals the name.
    const name = `e2e-${prefix}-${runId()}-${uid()}`.replace(/-+/g, '-');
    const bare = makeRemote(name, notes);
    const { id } = await this.addVault(name, `e2e/${name}`);
    await this.waitReady(id);
    return { id, name, bare };
  }

  /** Best effort: drop uncommitted changes, then remove the vault (never the remote). */
  async removeVault(id: string) {
    try {
      const st = await this.status(id).catch(() => null);
      if (st?.state === 'conflict') {
        for (const p of st.conflictPaths) await this.json('POST', `/vaults/${id}/conflicts/resolve`, { path: p, choice: 'theirs' }).catch(() => {});
      }
      for (const c of await this.changes(id).catch(() => [])) await this.json('POST', `/vaults/${id}/discard?path=${encodeURIComponent(c.path)}`).catch(() => {});
      await this.json('DELETE', `/vaults/${id}`);
    } catch { /* leave it; global teardown retries */ }
  }
}

export interface TestVault { id: string; name: string; bare: string }

/** Puts Ideas.md into Conflict: a local edit plus a clashing push from "Obsidian", then a commit (pull). */
export async function makeConflict(api: Api, vault: TestVault) {
  await api.write(vault.id, 'Ideas.md', '# Ideas mine\n\nBack to [[Home]].\n');
  pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas theirs\n\nBack to [[Home]].\n');
  const res = await api.ctx.post(`/api/vaults/${vault.id}/commit`, { data: { message: 'e2e: clash' } });
  expect(res.status()).toBe(409);
  await expect.poll(async () => (await api.status(vault.id)).state).toBe('conflict');
}


/** Opens the app with the token stored and `vaultId` as the active vault. */
export async function openApp(page: Page, vaultId?: string) {
  await page.addInitScript(([token, id]) => {
    // Only seed a fresh context: after a reload the app's own choice must win.
    if (localStorage.getItem('karpathy.e2e-seeded')) return;
    localStorage.setItem('karpathy.e2e-seeded', '1');
    localStorage.setItem('karpathy.token', token!);
    if (id) localStorage.setItem('karpathy.activeVault', id);
  }, [TOKEN, vaultId ?? '']);
  await page.goto('/');
  // The phone layout renders a second switcher in the chat list.
  if (vaultId) await expect(page.getByTestId('vault-switcher').first()).toContainText(vaultId, { timeout: 20_000 });
}

/** On a tablet the sidebar is an overlay: shows it if it is hidden. */
async function showSidebar(page: Page) {
  if ((await page.locator('#sidebar').getAttribute('inert')) !== null) await page.getByTestId('sidebar-toggle').click();
}

/** Opens the vault manager the way the user does: vault menu → Manage vaults…. */
export async function openVaults(page: Page) {
  await showSidebar(page);
  await page.getByTestId('vault-switcher').filter({ visible: true }).first().click();
  await page.getByTestId('manage-vaults').click();
  await expect(page.getByTestId('admin')).toBeVisible();
}

/** Opens the settings the way the user does. */
export async function openSettings(page: Page) {
  await showSidebar(page);
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

export const treeItem = (page: Page, path: string) => page.locator(`[data-testid="tree-item"][data-path="${path}"]`);

/** Expands the (collapsed by default, #53) folders above `path` in the file tree. */
export async function revealInTree(page: Page, path: string) {
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = treeItem(page, parts.slice(0, i).join('/'));
    if ((await dir.getAttribute('aria-expanded')) === 'false') await dir.click();
    await expect(dir).toHaveAttribute('aria-expanded', 'true');
  }
}

export async function openNote(page: Page, path: string) {
  await revealInTree(page, path);
  await treeItem(page, path).click();
  await expect(page.locator('.note-title')).toHaveText(path.split('/').pop()!.replace(/\.md$/, ''));
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** Types at the end of the document in the Write-mode editor. */
export async function typeAtEnd(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText(/^Saved/, { timeout: 15_000 });
}

export const test = base.extend<{ api: Api; vault: TestVault; cspGuard: void }>({
  // Fails a test whose page logged a Content-Security-Policy violation (prod proxy sends a CSP).
  cspGuard: [async ({ page }, use) => {
    const violations: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Content-Security-Policy/i.test(m.text())) violations.push(m.text()); });
    await use();
    expect(violations, 'CSP violations in the browser console').toEqual([]);
  }, { auto: true }],
  api: async ({}, use) => {
    const api = await Api.create();
    await use(api);
    await api.ctx.dispose();
  },
  vault: async ({ api }, use, info) => {
    const v = await api.createVault(info.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/^-+|-+$/g, ''));
    await use(v);
    await api.removeVault(v.id);
  },
});

export { expect };
