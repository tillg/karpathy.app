import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  INCOMING_PATHS_MAX,
  type Change,
  type CommitResult,
  type ConflictChoice,
  type FileContent,
  type FileEntry,
  type SearchHit,
  type Vault,
  type VaultConfig,
  type VaultEvent,
  type VaultState,
  type VaultStatus,
} from '@karpathy/shared';
import type { ConfigStore, StoredVault } from './config-store.js';
import { listTree, search, versionOf, versionOfFile } from './files.js';
import { Git, GitError, type GitIdentity } from './git.js';
import { VaultLock } from './lock.js';
import { normalizeRel, resolveInVault } from './paths.js';
import { preflight } from './preflight.js';
import { Repo } from './repo.js';
import { VaultWatcher } from './watcher.js';

/** A repo check that takes longer than this has hung (a stalled remote); the add is refused. */
const PREFLIGHT_TIMEOUT_MS = 60_000;
/** How often a vault that a browser has open is fetched in the background. */
const FETCH_INTERVAL_MS = 120_000;
/** A background fetch holds the vault lock (shared) at most this long; a commit or turn waits for it. */
const FETCH_TIMEOUT_MS = 30_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface VaultsEnv {
  vaultsDir: string;
  /** Clone URL = `${remoteBase}${owner/name}.git`; `https://github.com/` in prod, `file://…` in tests. */
  remoteBase: string;
  /** Read per git operation, so a token changed in the app applies without a restart. */
  githubToken?: () => string | undefined;
  /** Redacts every token value seen since startup; defaults to the current token. */
  redact?: (msg: string) => string;
  identity: GitIdentity;
  /** Background fetch interval while a browser has the vault open; default 2 min. */
  fetchIntervalMs?: number;
}

interface Runtime {
  lock: VaultLock;
  state: Exclude<VaultState, 'conflict'>;
  conflict: boolean;
  watcher?: VaultWatcher;
  listeners: Set<(e: VaultEvent) => void>;
  statusTimer?: NodeJS.Timeout;
  cloning?: Promise<void>;
  pullError?: string;
  /** The running background fetch; a second caller joins it. */
  fetching?: Promise<FetchOutcome>;
  /** Background fetch timer while the vault has event-stream subscribers. */
  fetchTimer?: NodeJS.Timeout;
}

type FetchOutcome = 'fetched' | 'offline' | 'skipped';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The vaults the app manages: admin, files, git, status events (mvp §2.3, §2.4, §3.2). */
export class Vaults {
  private rt = new Map<string, Runtime>();
  /** repo|branch|root of adds whose preflight is still running. */
  private adding = new Set<string>();
  /** Called when a vault's clone becomes ready (the chat service opens its subscription). */
  onReady?: (id: string) => void;
  /** Called under the lock once removal is allowed (the chat service deletes the vault's chats). */
  beforeRemove?: (id: string) => Promise<void>;

  constructor(
    private readonly store: ConfigStore,
    private readonly env: VaultsEnv,
  ) {}

  /** Loads configured vaults; re-clones any whose clone never finished. */
  async init(): Promise<void> {
    // Preflight temp clones left behind by a crash.
    await rm(this.preflightDir(), { recursive: true, force: true });
    for (const v of this.store.get().vaults) {
      const r = this.runtime(v.id);
      if (v.cloned) {
        r.state = 'ready';
        r.conflict = await this.repo(v).inConflict().catch(() => false);
        this.startWatcher(v);
      } else if (v.cloneError) r.state = 'clone-failed';
      else this.startClone(v);
    }
  }

  async close(): Promise<void> {
    for (const r of this.rt.values()) this.stopFetching(r);
    await Promise.all([...this.rt.values()].map((r) => r.watcher?.close()));
  }

  // ---- admin ----

  /** Can `token` reach each vault's repo and branch? (`git ls-remote`, nothing is fetched) */
  async checkAccess(token: string | undefined): Promise<{ id: string; repo: string; ok: boolean; error?: string }[]> {
    const git = new Git(tmpdir(), { identity: this.env.identity, token });
    return Promise.all(
      this.store.get().vaults.map(async (v) => {
        const r = await git.run(['ls-remote', '--exit-code', '--heads', `${this.env.remoteBase}${v.repo}.git`, v.branch], { allowFail: true });
        if (r.code === 0) return { id: v.id, repo: v.repo, ok: true };
        const error = r.code === 2
          ? `Can't reach ${v.repo}: branch "${v.branch}" doesn't exist there.`
          : cloneErrorText(new GitError(['ls-remote'], r.code, r.stderr, r.stdout), v).replace("Couldn't clone", "Can't reach");
        return { id: v.id, repo: v.repo, ok: false, error: this.redact(error) };
      }),
    );
  }

  list(): Vault[] {
    return this.store.get().vaults.map((v) => this.toVault(v));
  }

  getVault(id: string): Vault {
    return this.toVault(this.config(id));
  }

  async add(input: { name: string; repo: string; branch?: string; root?: string; createFolders?: boolean }): Promise<Vault> {
    if (!REPO_RE.test(input.repo)) throw new HttpError(400, 'repo must be owner/name');
    const root = input.root ? normalizeRel(input.root) : '';
    const branch = input.branch || 'main';
    this.refuseDuplicate(input.repo, branch, root);
    // The same repo being added concurrently counts as a duplicate too: preflight awaits a clone.
    const key = `${input.repo.toLowerCase()}|${branch}|${root}`;
    if (this.adding.has(key)) throw new HttpError(409, `${input.repo} (${branch}${root ? `, ${root}` : ''}) is being added already`, 'duplicate');
    this.adding.add(key);
    try {
      // Checked before anything is stored: a vault that fails here was never attached.
      const pre = await this.preflight(input.repo, branch, root);
      if (!pre.rootExists) throw new HttpError(422, `folder ${root} does not exist in the repo`, 'root-missing');
      if (pre.missing.length && !input.createFolders)
        throw new HttpError(409, `${input.repo} has no ${pre.missing.map((f) => `${f}/`).join(' and ')} folder`, 'missing-folders', { missing: pre.missing });
      return await this.attach(input, branch, root, pre.missing);
    } finally {
      this.adding.delete(key);
    }
  }

  private async attach(input: { name: string; repo: string }, branch: string, root: string, missing: string[]): Promise<Vault> {
    const id = this.freeId(input.name || input.repo.split('/')[1]!);
    const v: StoredVault = { id, name: input.name || input.repo, repo: input.repo, branch, root, cloned: false, ...(missing.length ? { pendingFolders: missing } : {}) };
    await this.store.update((c) => c.vaults.push(v));
    this.startClone(v);
    return this.toVault(v);
  }

  async patch(id: string, input: Partial<Pick<VaultConfig, 'name' | 'repo' | 'branch' | 'root'>>): Promise<Vault> {
    const v = this.config(id);
    const r = this.runtime(id);
    const next = { ...v };
    if (input.name !== undefined) next.name = input.name;
    const repoChange = input.repo !== undefined && input.repo !== v.repo;
    const branchChange = input.branch !== undefined && input.branch !== v.branch;
    const newRoot = input.root !== undefined ? (input.root ? normalizeRel(input.root) : '') : v.root;
    const rootChange = newRoot !== v.root;
    if (repoChange && !REPO_RE.test(input.repo!)) throw new HttpError(400, 'repo must be owner/name');
    if (repoChange || branchChange || rootChange) this.refuseDuplicate(input.repo ?? v.repo, input.branch ?? v.branch, newRoot, id);
    // A failed clone is retried, with the new settings if any (#9, #23): nothing local to lose.
    if (r.state === 'clone-failed' && (input.name === undefined || repoChange || branchChange || rootChange)) {
      next.repo = input.repo ?? v.repo;
      next.branch = input.branch ?? v.branch;
      next.root = newRoot;
      next.cloned = false;
      delete next.cloneError;
      await this.store.update((c) => {
        c.vaults = c.vaults.map((x) => (x.id === id ? next : x));
      });
      this.startClone(next);
      return this.toVault(next);
    }
    if (repoChange || branchChange || rootChange) {
      if (r.state === 'cloning') throw new HttpError(409, 'vault is still cloning');
      await r.lock.withExclusive(async () => {
        if (r.state === 'ready') {
          const repo = this.repo(v);
          if ((await repo.changes()).length > 0 || r.conflict) throw new HttpError(409, 'commit or discard uncommitted changes first', 'dirty');
          if ((await repo.unpushedCount()) > 0) throw new HttpError(409, 'push the unpushed commits first (retry the push)', 'unpushed');
        }
        if (repoChange) {
          next.repo = input.repo!;
          next.cloned = false;
          delete next.cloneError;
        }
        if (branchChange) next.branch = input.branch!;
        next.root = newRoot;
        if (!repoChange && r.state === 'ready') {
          const repo = this.repo(v);
          // Check the new root against the target branch before switching anything.
          if (branchChange) await repo.git.run(['fetch', '--end-of-options', 'origin', next.branch]);
          const ref = branchChange ? `origin/${next.branch}` : 'HEAD';
          if (newRoot && (await repo.git.run(['cat-file', '-t', `${ref}:${newRoot}`], { allowFail: true })).stdout.trim() !== 'tree')
            throw new HttpError(400, `folder ${newRoot} does not exist in the repo`);
          if (branchChange) await repo.checkoutBranch(next.branch);
        }
      });
      await this.store.update((c) => {
        c.vaults = c.vaults.map((x) => (x.id === id ? next : x));
        delete c.aiTouched[id];
      });
      if (repoChange || (branchChange && r.state !== 'ready')) {
        await r.watcher?.close();
        r.watcher = undefined;
        this.startClone(next);
      } else if (rootChange) {
        await r.watcher?.close();
        this.startWatcher(next);
      }
    } else {
      await this.store.update((c) => {
        c.vaults = c.vaults.map((x) => (x.id === id ? next : x));
      });
    }
    this.emitStatusSoon(id);
    return this.toVault(next);
  }

  async remove(id: string): Promise<void> {
    const v = this.config(id);
    const r = this.runtime(id);
    await r.cloning?.catch(() => undefined);
    await r.lock.withExclusive(async () => {
      if (r.state === 'ready') {
        const repo = this.repo(v);
        if ((await repo.changes()).length > 0 || r.conflict) throw new HttpError(409, 'commit or discard uncommitted changes first', 'dirty');
        if ((await repo.unpushedCount()) > 0) throw new HttpError(409, 'push unpushed commits first', 'unpushed');
      }
      await this.beforeRemove?.(id);
      await r.watcher?.close();
      await rm(this.cloneDir(id), { recursive: true, force: true });
      await this.store.update((c) => {
        c.vaults = c.vaults.filter((x) => x.id !== id);
        delete c.aiTouched[id];
        delete c.conflicts[id];
      });
    });
    this.stopFetching(r);
    this.rt.delete(id);
  }

  // ---- status / events ----

  lock(id: string): VaultLock {
    this.config(id);
    return this.runtime(id).lock;
  }

  isConflict(id: string): boolean {
    return this.runtime(id).conflict;
  }

  vaultRootDir(id: string): string {
    const v = this.config(id);
    return join(this.cloneDir(id), v.root);
  }

  async status(id: string): Promise<VaultStatus> {
    const v = this.config(id);
    const r = this.runtime(id);
    const base: VaultStatus = { state: this.stateOf(v), changedCount: 0, unpushedCount: 0, incomingCount: 0, incomingPaths: [], busy: r.lock.busy, conflictPaths: [], ...(r.pullError ? { pullError: r.pullError } : {}) };
    if (r.state !== 'ready') return base;
    const repo = this.repo(v);
    const [changes, unpushed, incoming] = await Promise.all([repo.changes(), repo.unpushedCount(), repo.incomingPaths()]);
    base.changedCount = changes.length;
    base.unpushedCount = unpushed;
    base.incomingCount = incoming.length;
    base.incomingPaths = incoming.slice(0, INCOMING_PATHS_MAX);
    if (r.conflict)
      base.conflictPaths = (this.store.get().conflicts[id] ?? []).map((p) => repo.toVaultPath(p) ?? p);
    return base;
  }

  /** The only subscriber is the event stream, so "someone listens" = "a browser has the vault open": fetch on connect and every interval. */
  subscribe(id: string, fn: (e: VaultEvent) => void): () => void {
    const r = this.runtime(id);
    r.listeners.add(fn);
    r.fetchTimer ??= setInterval(() => void this.fetchRemote(id), this.env.fetchIntervalMs ?? FETCH_INTERVAL_MS);
    void this.fetchRemote(id);
    return () => {
      r.listeners.delete(fn);
      if (r.listeners.size === 0) this.stopFetching(r);
    };
  }

  private stopFetching(r: Runtime) {
    clearInterval(r.fetchTimer);
    r.fetchTimer = undefined;
  }

  private emit(id: string, e: VaultEvent) {
    for (const fn of this.rt.get(id)?.listeners ?? []) fn(e);
  }

  /** Coalesces status recomputation (lock changes, file events, git ops). */
  emitStatusSoon(id: string) {
    const r = this.rt.get(id);
    if (!r || r.statusTimer) return;
    r.statusTimer = setTimeout(() => {
      r.statusTimer = undefined;
      if (!this.rt.has(id) || r.listeners.size === 0) return;
      this.status(id).then(
        (status) => this.emit(id, { type: 'status', status }),
        () => undefined,
      );
    }, 50);
  }

  // ---- files ----

  async listFiles(id: string): Promise<FileEntry[]> {
    this.requireReady(id);
    return listTree(this.vaultRootDir(id));
  }

  async readFile(id: string, path: string): Promise<FileContent> {
    this.requireReady(id);
    const abs = await resolveInVault(this.vaultRootDir(id), path);
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `not found: ${path}`);
      if ((e as NodeJS.ErrnoException).code === 'EISDIR') throw new HttpError(400, `is a directory: ${path}`);
      throw e;
    }
    const binary = !isText(buf);
    return { path: normalizeRel(path), content: binary ? '' : buf.toString('utf8'), version: versionOf(buf), binary };
  }

  /** Absolute path of a file to stream raw (media embeds, downloads): no read, no version. */
  async rawFile(id: string, path: string): Promise<string> {
    this.requireReady(id);
    // Hidden files and folders (.obsidian, .git, `.`/`..`) are never raw-served.
    if (path.split('/').some((seg) => seg.startsWith('.'))) throw new HttpError(400, `not served: ${path}`);
    const abs = await resolveInVault(this.vaultRootDir(id), path);
    let st;
    try {
      st = await stat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `not found: ${path}`);
      throw e;
    }
    if (st.isDirectory()) throw new HttpError(400, `is a directory: ${path}`);
    return abs;
  }

  /** Writes a file if `version` still matches (null = must not exist yet). 409 stale, 423 in Conflict. */
  async writeFile(id: string, path: string, content: string, version: string | null, force = false): Promise<{ version: string }> {
    this.requireReady(id);
    const r = this.runtime(id);
    return r.lock.withShared('save', async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      const abs = await resolveInVault(this.vaultRootDir(id), path);
      // Before the version check: on a case-insensitive disk the twin would look like "the same file".
      if (version === null) {
        checkNewName(path);
        await this.refuseCaseTwin(id, path);
      }
      const current = await versionOfFile(abs);
      if (!force && current !== version)
        throw new HttpError(409, 'file changed since it was loaded', 'stale', { currentVersion: current });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      this.emitStatusSoon(id);
      return { version: versionOf(content) };
    });
  }

  /**
   * A new path must not differ only in case from an existing file or folder: the vault's
   * clones on macOS/Windows (Obsidian) can't hold both.
   */
  private async refuseCaseTwin(id: string, path: string) {
    let dir = this.vaultRootDir(id);
    for (const seg of normalizeRel(path).split('/')) {
      const names = await readdir(dir).catch(() => [] as string[]);
      if (names.includes(seg)) {
        dir = join(dir, seg);
        continue;
      }
      const twin = names.find((n) => n.toLowerCase() === seg.toLowerCase());
      if (twin) throw new HttpError(409, `"${twin}" already exists (names differ only in upper/lower case)`, 'exists-case', { existing: twin });
      return;
    }
  }

  /** Like `git rm`: drops the folders that removing `abs` emptied (git can't hold them, other clones won't have them). */
  private async removeEmptiedFolders(id: string, abs: string): Promise<void> {
    const root = this.vaultRootDir(id);
    for (let dir = dirname(abs); dir.startsWith(`${root}/`) && existsSync(dir) && (await readdir(dir)).length === 0; dir = dirname(dir)) await rmdir(dir);
  }

  async deleteFile(id: string, path: string, version: string): Promise<void> {
    this.requireReady(id);
    const r = this.runtime(id);
    await r.lock.withShared('save', async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      const abs = await resolveInVault(this.vaultRootDir(id), path);
      const current = await versionOfFile(abs);
      if (current === null) throw new HttpError(404, `not found: ${path}`);
      if (current !== version) throw new HttpError(409, 'file changed since it was loaded', 'stale', { currentVersion: current });
      await rm(abs);
      await this.removeEmptiedFolders(id, abs);
      this.emitStatusSoon(id);
    });
  }

  async search(id: string, q: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    this.requireReady(id);
    if (!q.trim()) return { hits: [], truncated: false };
    if (/[\r\n]/.test(q)) throw new HttpError(400, 'search text must be a single line', 'bad-query');
    return search(this.vaultRootDir(id), q);
  }

  // ---- git ----

  async changes(id: string): Promise<Change[]> {
    this.requireReady(id);
    const repo = this.repo(this.config(id));
    return Promise.all((await repo.changes()).map(async (c) => ({ ...c, version: await versionOfFile(join(repo.rootDir, c.path)) })));
  }

  async diff(id: string, path: string): Promise<string> {
    this.requireReady(id);
    return this.repo(this.config(id)).diff(normalizeRel(path));
  }

  async fullDiff(id: string) {
    this.requireReady(id);
    return this.repo(this.config(id)).fullDiff();
  }

  /**
   * Background fetch: updates origin/<branch> only, so the status can count incoming changes.
   * Runs next to saves and turns (shared 'fetch' holder), skips while a git op holds or waits for
   * the lock; a second caller joins the running fetch. Never rejects: it runs from a timer.
   */
  fetchRemote(id: string): Promise<FetchOutcome> {
    const r = this.rt.get(id);
    if (!r) return Promise.resolve('skipped');
    r.fetching ??= this.fetchOnce(id, r).catch(() => 'skipped' as const).finally(() => { r.fetching = undefined; });
    return r.fetching;
  }

  private async fetchOnce(id: string, r: Runtime): Promise<FetchOutcome> {
    if (r.state !== 'ready') return 'skipped';
    const release = r.lock.tryShared('fetch');
    if (!release) return 'skipped';
    try {
      const v = this.config(id);
      const repo = new Repo(this.cloneDir(id), v.branch, v.root, { identity: this.env.identity, token: this.env.githubToken?.(), timeoutMs: FETCH_TIMEOUT_MS });
      const ref = async () => (await repo.git.run(['rev-parse', '-q', '--verify', `origin/${v.branch}`], { allowFail: true })).stdout.trim();
      const before = await ref();
      const result = await repo.fetchUpstream();
      const pullError = result.ok ? undefined : this.redact(result.error);
      const errorChanged = pullError !== r.pullError;
      if (pullError && !r.pullError) console.warn(`background fetch of ${v.repo} failed:`, pullError);
      r.pullError = pullError;
      // Only on a change: every status event makes the web app reload the Changes list.
      if (errorChanged || (await ref()) !== before) this.emitStatusSoon(id);
      return result.ok ? 'fetched' : 'offline';
    } finally {
      release();
    }
  }

  /** The pull on vault open: skipped when the lock isn't immediately free. */
  async open(id: string): Promise<VaultStatus> {
    const r = this.runtime(id);
    this.config(id);
    // A background fetch started by the same app load would make tryExclusive skip the pull.
    await r.fetching;
    if (r.state === 'ready' && !r.conflict) {
      const release = r.lock.tryExclusive();
      if (release) {
        try {
          await this.pullUnlocked(id);
        } finally {
          release();
        }
      }
    }
    return this.status(id);
  }

  /** The user's pull (tap on the incoming count): the same pull as on open, commit and turn. */
  async pull(id: string): Promise<VaultStatus> {
    this.requireReady(id);
    const r = this.runtime(id);
    await r.lock.withExclusive(async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      await this.pullUnlocked(id);
    });
    return this.status(id);
  }

  /** Pull under a lock the caller already holds exclusively. Records a Conflict if one arises. */
  async pullUnlocked(id: string) {
    const r = this.runtime(id);
    if (r.state !== 'ready' || r.conflict) return null;
    const result = await this.repo(this.config(id)).pull();
    r.pullError = result.kind === 'offline' ? this.redact(result.error) : undefined;
    if (result.kind === 'conflict') {
      await this.store.update((c) => {
        c.conflicts[id] = result.paths;
      });
      r.conflict = true;
    }
    this.emitStatusSoon(id);
    return result;
  }

  /** `paths`: the changed files the user reviewed; if others arrived while waiting → 409 (#33). */
  async commit(id: string, message: string, paths?: string[]): Promise<CommitResult> {
    this.requireReady(id);
    const r = this.runtime(id);
    if (!message.trim()) throw new HttpError(400, 'commit message is required');
    return r.lock.withExclusive(async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      const pull = await this.pullUnlocked(id);
      if (pull?.kind === 'conflict') throw new HttpError(409, 'pull ran into a conflict; resolve it, then commit', 'conflict');
      const repo = this.repo(this.config(id));
      const changed = new Set((await repo.changes()).map((c) => c.path));
      if (paths && (paths.length !== changed.size || paths.some((p) => !changed.has(p))))
        throw new HttpError(409, 'The changes differ from what you reviewed (e.g. the AI changed more files while the commit waited). Review them and commit again.', 'changes-moved', { paths: [...changed] });
      const touched = this.store.get().aiTouched[id] ?? [];
      const withAi = touched.some((p) => changed.has(p));
      const commit = await repo.commit(message, withAi);
      if (commit) await this.store.update((c) => { delete c.aiTouched[id]; });
      const unpushed = await repo.unpushedCount();
      const push = unpushed > 0 ? await repo.push() : { pushed: false };
      this.emitStatusSoon(id);
      return { commit, pushed: push.pushed, ...(push.error ? { pushError: push.error } : {}) };
    });
  }

  async push(id: string): Promise<CommitResult> {
    this.requireReady(id);
    const r = this.runtime(id);
    return r.lock.withExclusive(async () => {
      const pull = await this.pullUnlocked(id);
      this.emitStatusSoon(id);
      if (pull?.kind === 'offline') return { commit: null, pushed: false, pushError: pull.error };
      if (pull?.kind === 'conflict') throw new HttpError(409, 'pull ran into a conflict', 'conflict');
      return { commit: null, pushed: pull?.kind === 'ok' && pull.pushed, ...(pull?.kind === 'ok' && pull.pushError ? { pushError: pull.pushError } : {}) };
    });
  }

  /**
   * `version` = what the user saw when confirming (from GET /changes). Discard waits for a
   * running AI turn; if the file changed meanwhile, it refuses instead of throwing away edits
   * the user never reviewed (#32).
   */
  async discard(id: string, path: string, version?: string | null): Promise<void> {
    this.requireReady(id);
    const r = this.runtime(id);
    const rel = normalizeRel(path);
    await r.lock.withExclusive(async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      if (version !== undefined) {
        const current = await versionOfFile(await resolveInVault(this.vaultRootDir(id), rel));
        if (current !== version) throw new HttpError(409, `${rel} changed since you looked at it; review it again`, 'stale', { currentVersion: current });
      }
      await this.repo(this.config(id)).discard(rel);
      await this.removeEmptiedFolders(id, join(this.vaultRootDir(id), rel));
      await this.store.update((c) => {
        const set = c.aiTouched[id];
        if (set) c.aiTouched[id] = set.filter((p) => p !== rel);
      });
    });
    this.emitStatusSoon(id);
  }

  async resolveConflict(id: string, path: string, choice: ConflictChoice): Promise<VaultStatus> {
    this.requireReady(id);
    const r = this.runtime(id);
    const repo = this.repo(this.config(id));
    const repoPath = repo.toRepoPath(normalizeRel(path));
    await r.lock.withExclusive(async () => {
      if (!r.conflict) throw new HttpError(409, 'vault is not in conflict');
      const open = this.store.get().conflicts[id] ?? (await repo.computeConflictPaths());
      if (!open.includes(repoPath)) throw new HttpError(400, `not a conflicting path: ${path}`);
      await repo.resolve(repoPath, choice);
      const rest = open.filter((p) => p !== repoPath);
      if (rest.length === 0) {
        await repo.finishConflict();
        r.conflict = false;
      }
      await this.store.update((c) => {
        if (rest.length) c.conflicts[id] = rest;
        else delete c.conflicts[id];
      });
    });
    this.emitStatusSoon(id);
    return this.status(id);
  }

  /** Mine/theirs contents of one conflicting path, for the resolution UI. */
  async conflictSides(id: string, path: string): Promise<{ mine: string | null; theirs: string | null }> {
    this.requireReady(id);
    const repo = this.repo(this.config(id));
    const s = await repo.conflictSides(repo.toRepoPath(normalizeRel(path)));
    return { mine: s.mine?.toString('utf8') ?? null, theirs: s.theirs?.toString('utf8') ?? null };
  }

  /**
   * opencode project config found in the vault (vault root up to the clone root), or null.
   * While there is any, no request for this vault may reach opencode: loading it would run
   * the repo's plugins/tools/MCP servers in the harness (#27).
   */
  harnessConfigIn(id: string): string | null {
    const v = this.config(id);
    const clone = this.cloneDir(id);
    const segs = v.root ? v.root.split('/') : [];
    for (let i = segs.length; i >= 0; i--) {
      const dir = join(clone, ...segs.slice(0, i));
      for (const name of HARNESS_CONFIG) {
        if (existsSync(join(dir, name))) return [...segs.slice(0, i), name].join('/');
      }
    }
    return null;
  }

  /** Records vault-relative paths the AI changed (mvp §2.4 AI-touched set). */
  async markAiTouched(id: string, paths: string[]): Promise<void> {
    if (!this.store.get().vaults.some((v) => v.id === id)) return;
    const cur = new Set(this.store.get().aiTouched[id] ?? []);
    const before = cur.size;
    // Absolute = outside the vault root; it can never be committed from here.
    for (const p of paths) if (!p.startsWith('/')) cur.add(p);
    if (cur.size !== before) await this.store.update((c) => { c.aiTouched[id] = [...cur]; });
  }

  aiTouched(id: string): string[] {
    return this.store.get().aiTouched[id] ?? [];
  }

  // ---- internals ----

  private config(id: string): StoredVault {
    const v = this.store.get().vaults.find((x) => x.id === id);
    if (!v) throw new HttpError(404, `no such vault: ${id}`);
    return v;
  }

  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) {
      const lock = new VaultLock();
      r = { lock, state: 'cloning', conflict: false, listeners: new Set() };
      lock.onChange(() => this.emitStatusSoon(id));
      this.rt.set(id, r);
    }
    return r;
  }

  private requireReady(id: string) {
    const v = this.config(id);
    const r = this.runtime(id);
    if (r.state !== 'ready') throw new HttpError(409, `vault is ${this.stateOf(v)}`, 'not-ready');
  }

  private stateOf(v: StoredVault): VaultState {
    const r = this.runtime(v.id);
    return r.state === 'ready' && r.conflict ? 'conflict' : r.state;
  }

  private toVault(v: StoredVault): Vault {
    const { cloned: _c, cloneError, ...cfg } = v;
    return { ...cfg, state: this.stateOf(v), ...(cloneError ? { error: cloneError } : {}) };
  }

  private cloneDir(id: string) {
    return join(resolve(this.env.vaultsDir), id);
  }

  private repo(v: StoredVault): Repo {
    return new Repo(this.cloneDir(v.id), v.branch, v.root, { identity: this.env.identity, token: this.env.githubToken?.() });
  }

  private refuseDuplicate(repo: string, branch: string, root: string, exceptId?: string) {
    // GitHub owner/repo names are case-insensitive.
    const dup = this.store.get().vaults.find((x) => x.id !== exceptId && x.repo.toLowerCase() === repo.toLowerCase() && x.branch === branch && x.root === root);
    if (dup) throw new HttpError(409, `"${dup.name}" already uses ${repo} (${branch}${root ? `, ${root}` : ''})`, 'duplicate');
  }

  /** Placeholders for folders the user agreed to create; uncommitted until the user commits (ADR 0001). */
  private async createFolders(id: string, folders: string[]) {
    const root = this.vaultRootDir(id);
    const present = new Set((await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()));
    for (const f of folders) {
      if (present.has(f.toLowerCase())) continue; // pushed in the meantime
      await mkdir(join(root, f)).catch((e: NodeJS.ErrnoException) => {
        throw new Error(e.code === 'EEXIST' ? `can't create folder ${f}: a file with that name exists` : e.message);
      });
      await writeFile(join(root, f, '.gitkeep'), '');
    }
  }

  private preflightDir() {
    return join(resolve(this.env.vaultsDir), '.preflight');
  }

  private async preflight(repo: string, branch: string, root: string) {
    const dir = this.preflightDir();
    await mkdir(dir, { recursive: true });
    try {
      return await preflight(`${this.env.remoteBase}${repo}.git`, branch, root, { dir, identity: this.env.identity, token: this.env.githubToken?.(), timeoutMs: PREFLIGHT_TIMEOUT_MS });
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      console.warn(`preflight of ${repo} failed:`, this.redact(e.message));
      throw new HttpError(422, this.redact(cloneErrorText(e, { repo, branch })), 'repo-unreachable');
    }
  }

  private redact(msg: string): string {
    return this.env.redact ? this.env.redact(msg) : redactToken(msg, this.env.githubToken?.());
  }

  private freeId(name: string): string {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vault';
    const ids = new Set(this.store.get().vaults.map((v) => v.id));
    let id = slug;
    for (let n = 2; ids.has(id); n++) id = `${slug}-${n}`;
    return id;
  }

  private startClone(v: StoredVault) {
    const r = this.runtime(v.id);
    r.state = 'cloning';
    r.conflict = false;
    this.emitStatusSoon(v.id);
    r.cloning = r.lock.withExclusive(async () => {
      try {
        await Repo.clone(`${this.env.remoteBase}${v.repo}.git`, this.cloneDir(v.id), v.branch, { identity: this.env.identity, token: this.env.githubToken?.() });
        if (v.root) {
          const st = await stat(join(this.cloneDir(v.id), v.root)).catch(() => null);
          if (!st?.isDirectory()) throw new Error(`folder ${v.root} does not exist in the repo`);
        }
        if (v.pendingFolders?.length) await this.createFolders(v.id, v.pendingFolders);
        await this.store.update((c) => {
          const x = c.vaults.find((y) => y.id === v.id);
          if (x) {
            x.cloned = true;
            delete x.cloneError;
            delete x.pendingFolders;
          }
        });
        r.state = 'ready';
        this.startWatcher(v);
        this.onReady?.(v.id);
      } catch (e) {
        console.warn(`clone of ${v.repo} failed:`, this.redact((e as Error).message));
        const msg = this.redact(cloneErrorText(e as Error, v));
        await this.store.update((c) => {
          const x = c.vaults.find((y) => y.id === v.id);
          if (x) x.cloneError = msg;
        });
        r.state = 'clone-failed';
      }
      this.emitStatusSoon(v.id);
    });
  }

  /** Waits for a running clone (tests, startup). */
  async whenCloned(id: string): Promise<void> {
    await this.runtime(id).cloning;
  }

  private startWatcher(v: StoredVault) {
    const r = this.runtime(v.id);
    const root = join(this.cloneDir(v.id), v.root);
    r.watcher = new VaultWatcher(root, async (paths) => {
      const files = await Promise.all(
        paths.map(async (path) => ({ path, version: await versionOfFile(join(root, path)) })),
      );
      this.emit(v.id, { type: 'files-changed', files });
      this.emitStatusSoon(v.id);
    });
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** opencode loads these from a vault as project config: plugins, tools, MCP servers = code (#27). */
export const HARNESS_CONFIG = ['.opencode', 'opencode.json', 'opencode.jsonc'];

/** New file names must work in every clone (Obsidian on macOS, Windows, iOS). */
function checkNewName(path: string) {
  if (path.endsWith('/')) throw new HttpError(400, 'A file name must not end with "/"', 'bad-name');
  for (const seg of normalizeRel(path).split('/')) {
    if (HARNESS_CONFIG.includes(seg)) throw new HttpError(400, `"${seg}" is reserved: it would configure the AI harness`, 'bad-name');
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\x00-\x1f<>:"|?*\\]/.test(seg)) throw new HttpError(400, `"${seg}" contains a character that isn't allowed in file names (<>:"|?* or control characters)`, 'bad-name');
    if (RESERVED.test(seg)) throw new HttpError(400, `"${seg}" is a reserved name on Windows`, 'bad-name');
    if (/[. ]$/.test(seg)) throw new HttpError(400, `"${seg}" must not end with a dot or space`, 'bad-name');
  }
}

/** Valid UTF-8 without NUL bytes. */
function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** git's clone stderr → a message for the admin UI, without container paths (#48). */
function cloneErrorText(e: Error, v: Pick<StoredVault, 'repo' | 'branch'>): string {
  const m = e.message;
  if (!(e instanceof GitError)) return m; // e.g. our own "folder … does not exist in the repo"
  if (/Remote branch .* not found/i.test(m)) return `Couldn't clone ${v.repo}: branch "${v.branch}" doesn't exist there.`;
  if (/not found|does not appear to be a git repository|could not read from remote|authentication failed|403/i.test(m))
    return `Couldn't clone ${v.repo}: the repository doesn't exist, or the server's GitHub token has no access to it.`;
  if (/could not resolve host|unable to access|timed out|connection/i.test(m)) return `Couldn't clone ${v.repo}: GitHub is not reachable from the server right now.`;
  return `Couldn't clone ${v.repo}: ${m.split('\n').find((l) => l.startsWith('fatal:'))?.replace(/^fatal:\s*/, '').replace(/'\/[^']*'/g, '…') ?? 'git failed'}`;
}

function redactToken(msg: string, token?: string) {
  return token ? msg.replaceAll(token, '***') : msg;
}
