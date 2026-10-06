import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  INCOMING_PATHS_MAX,
  type AgentsMove,
  type Change,
  type CommitResult,
  type ConflictChoice,
  type FileContent,
  type FileEntry,
  type SearchHit,
  type UploadResult,
  type Vault,
  type VaultConfig,
  type VaultEvent,
  type VaultState,
  type VaultStatus,
} from '@karpathy/shared';
import { isUploadable, MAX_ATTACHMENT_BYTES, rewriteLinks } from '@karpathy/shared';
import { hasLegacy, isEmptyMove, migrateToAgents, restageSkillLink, scanLegacy } from './agents-standard.js';
import type { ConfigStore, StoredVault } from './config-store.js';
import { filesMentioning, listTree, search, versionOf, versionOfFile } from './files.js';
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
/** How long the pull on vault open waits for a skill-list refresh to let go of the lock. */
const REFRESH_WAIT_MS = 5_000;
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
  /** What the last agents move left behind (clashes), so it isn't moved and announced again. */
  legacySeen?: string;
  /** The last agents move, for a client that connects later. */
  lastMove?: AgentsMove & { at: number };
}

type FetchOutcome = 'fetched' | 'offline' | 'skipped';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The vaults the app manages: admin, files, git, status events (mvp §2.3, §2.4, §3.2). */
export class Vaults {
  private rt = new Map<string, Runtime>();
  /** Running commit-message proposals per vault (they take no lock; a skill refresh must not cut them off). */
  private proposals = new Map<string, number>();
  /** repo|branch|root of adds whose preflight is still running. */
  private adding = new Set<string>();
  /** Called when a vault's clone becomes ready (the chat service opens its subscription). */
  onReady?: (id: string) => void;
  /** Test seam: runs between a move's link scan and its first write. */
  afterRelinkScan?: () => Promise<void>;
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
    this.config(id);
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

  /**
   * A chat attachment may be sent: a raw-servable file (inside the vault root, no hidden segment, no
   * symlink), uploadable, at most MAX_ATTACHMENT_BYTES. The only guard: opencode reads the `file:` URL as given.
   */
  async checkAttachment(id: string, path: string): Promise<void> {
    let abs;
    try {
      abs = await this.rawFile(id, path);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `Attachment not found: ${path}`);
      throw new HttpError(400, `Attachment can't be sent: ${path} (${(e as Error).message})`);
    }
    if (!isUploadable(path)) throw new HttpError(400, `Attachment can't be sent: ${path} (only JPEG, PNG, GIF, WebP and PDF)`);
    if ((await stat(abs)).size > MAX_ATTACHMENT_BYTES) throw new HttpError(400, `Attachment can't be sent: ${path} (larger than 20 MB)`);
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

  /** Stores an uploaded file next to the note it is for (its own folder); never overwrites. 423 in Conflict. */
  async upload(id: string, name: string, target: { note: string } | { source: string; at?: string }, bytes: Buffer): Promise<UploadResult> {
    this.requireReady(id);
    checkUploadName(name);
    const r = this.runtime(id);
    return r.lock.withShared('save', async () => {
      if (r.conflict) throw new HttpError(423, 'vault is in conflict; resolve it first', 'conflict');
      if ('source' in target) {
        const path = await this.writeNew(id, await this.sourceFolder(id, target.source, target.at), name, bytes);
        this.emitStatusSoon(id);
        return { path, version: versionOf(bytes), size: bytes.length };
      }
      const note = await this.checkNote(id, target.note);
      const { folder, move } = attachmentFolder(note);
      const write = (into: string) => this.writeNew(id, into, name, bytes);
      const moved = move ? await this.moveIntoOwnFolder(id, note, folder, write) : undefined;
      const path = moved?.path ?? (await write(folder));
      this.emitStatusSoon(id);
      return { path, version: versionOf(bytes), size: bytes.length, ...(moved ? { moved: { from: note, to: moved.to }, rewritten: moved.rewritten } : {}) };
    });
  }

  /** The page an editor upload is for: an existing `.md`, not in a hidden folder, a name every clone can hold. */
  private async checkNote(id: string, path: string): Promise<string> {
    const note = normalizeRel(path);
    if (!/\.md$/i.test(note)) throw new HttpError(400, `attachments go next to a page (.md): ${note}`, 'bad-path');
    if (note.split('/').some((seg) => seg.startsWith('.'))) throw new HttpError(400, `not a page in the vault: ${note}`, 'bad-path');
    checkNewName(note);
    const st = await stat(await resolveInVault(this.vaultRootDir(id), note)).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, `not found: ${note}`);
    return note;
  }

  /**
   * Moves the flat page `dir/stem.md` to `folder/stem.md` (its own folder) before its first attachment,
   * rewriting the path-form links to it and the relative links in it. Every check runs before the first write.
   */
  private async moveIntoOwnFolder(id: string, note: string, folder: string, write: (folder: string) => Promise<string>): Promise<{ to: string; rewritten: string[]; path: string }> {
    const root = this.vaultRootDir(id);
    const base = note.slice(note.lastIndexOf('/') + 1);
    // A running turn could write the old path again.
    if (this.runtime(id).lock.busy === 'turn') throw new HttpError(409, "The AI is working. Attach again when it's done.", 'ai-busy');
    // A folder of that name in other case is the page's folder: no case twin next to it.
    const dir = dirname(folder) === '.' ? '' : dirname(folder);
    const existing = (await readdir(join(root, dir), { withFileTypes: true })).find((e) => e.name.toLowerCase() === basename(folder).toLowerCase());
    if (existing && !existing.isDirectory()) throw new HttpError(409, `${dir ? `${dir}/` : ''}${existing.name} is a file, so ${note} can't move into its own folder`, 'folder-taken');
    const own = existing ? `${dir ? `${dir}/` : ''}${existing.name}` : folder;
    const to = `${own}/${base}`;
    const from = await resolveInVault(root, note);
    const dest = await resolveInVault(root, to);
    const there = await readdir(dirname(dest)).catch(() => [] as string[]);
    if (there.some((n) => n.toLowerCase() === base.toLowerCase())) throw new HttpError(409, `${to} already exists, so ${note} can't move into its own folder`, 'folder-taken');

    const paths = (await listTree(root)).filter((f) => f.type === 'file').map((f) => f.path);
    const stem = base.replace(/\.md$/i, '');
    const edits: { path: string; abs: string; version: string; text: string }[] = [];
    for (const path of await filesMentioning(root, [...new Set([stem, stem.replaceAll(' ', '%20'), encodeURI(stem)])])) {
      if (path === note) continue;
      const abs = join(root, path);
      const buf = await readFile(abs);
      const text = rewriteLinks(buf.toString('utf8'), path, note, to, paths);
      if (text !== buf.toString('utf8')) edits.push({ path, abs, version: versionOf(buf), text });
    }
    const ownBuf = await readFile(from);
    const ownText = rewriteLinks(ownBuf.toString('utf8'), note, note, to, paths);
    await this.afterRelinkScan?.();
    // Every check before the first write: a page changed since the scan (the moved one too) refuses the move.
    for (const e of [...edits, { path: note, abs: from, version: versionOf(ownBuf) }])
      if ((await versionOfFile(e.abs)) !== e.version) throw new HttpError(409, `${e.path} changed while moving ${note}; attach again`, 'stale');
    // The attachment first: if it can't be written, nothing has moved.
    const path = await write(own);
    for (const e of edits) await writeFile(e.abs, e.text);
    await rename(from, dest);
    if (ownText !== ownBuf.toString('utf8')) await writeFile(dest, ownText);
    if (this.aiTouched(id).includes(note))
      await this.store.update((c) => { c.aiTouched[id] = c.aiTouched[id]!.map((p) => (p === note ? to : p)); });
    return { to, rewritten: edits.map((e) => e.path), path };
  }


  /**
   * The source folder a chat upload goes into: `new` makes `Sources/upload-<at>` (`-2`, `-3` … if taken),
   * anything else must name an existing `upload-…` folder directly in `Sources/`. `Sources/` is matched
   * case-insensitively and keeps its spelling.
   */
  private async sourceFolder(id: string, source: string, at?: string): Promise<string> {
    const root = this.vaultRootDir(id);
    const top = (await readdir(root, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.toLowerCase() === 'sources')?.name ?? 'Sources';
    const names = await readdir(join(root, top)).catch(() => [] as string[]);
    if (source !== 'new') {
      if (!/^upload-[^/\\]+$/.test(source) || !names.includes(source)) throw new HttpError(400, `not an upload folder in ${top}/: ${source}`, 'bad-path');
      return `${top}/${source}`;
    }
    if (!at || !/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(at)) throw new HttpError(400, 'at must be the local time as YYYY-MM-DD-HHMMSS', 'invalid');
    await mkdir(join(root, top), { recursive: true });
    for (let n = 1; n <= 100; n++) {
      const folder = `upload-${at}${n === 1 ? '' : `-${n}`}`;
      if (names.some((x) => x.toLowerCase() === folder.toLowerCase())) continue;
      try {
        // Claims the folder: a second `new` at the same second gets the next one.
        await mkdir(join(root, top, folder));
        return `${top}/${folder}`;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new HttpError(409, `no free upload folder for ${at}`, 'exists');
  }

  /**
   * Writes `bytes` as `folder/name`, or `name-2`, `name-3` … when a file of that base name exists
   * anywhere in the vault (case-insensitive), so a bare `![[name]]` is never ambiguous. Never overwrites.
   */
  private async writeNew(id: string, folder: string, name: string, bytes: Buffer): Promise<string> {
    const root = this.vaultRootDir(id);
    const taken = new Set((await listTree(root)).filter((f) => f.type === 'file').map((f) => f.path.slice(f.path.lastIndexOf('/') + 1).toLowerCase()));
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; n <= 100; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      if (taken.has(candidate.toLowerCase())) continue;
      const path = folder ? `${folder}/${candidate}` : candidate;
      const abs = await resolveInVault(root, path);
      await mkdir(dirname(abs), { recursive: true });
      try {
        await writeFile(abs, bytes, { flag: 'wx' });
        return path;
      } catch (e) {
        // Another upload took it since the listing.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        taken.add(candidate.toLowerCase());
      }
    }
    throw new HttpError(409, `no free name for ${name}`, 'exists');
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
      const repo = this.repo(v, FETCH_TIMEOUT_MS);
      const before = await repo.upstreamHead();
      const result = await repo.fetchUpstream();
      const pullError = result.ok ? undefined : this.redact(result.error);
      const errorChanged = pullError !== r.pullError;
      if (pullError && !r.pullError) console.warn(`background fetch of ${v.repo} failed:`, pullError);
      r.pullError = pullError;
      // Only on a change: every status event makes the web app reload the Changes list.
      if (errorChanged || (await repo.upstreamHead()) !== before) this.emitStatusSoon(id);
      return result.ok ? 'fetched' : 'offline';
    } finally {
      release();
    }
  }

  /** The pull on vault open: skipped when the lock isn't immediately free. */
  async open(id: string): Promise<VaultStatus> {
    const r = this.runtime(id);
    this.config(id);
    // A background fetch started by the same app load would make tryExclusive skip the pull; so would the
    // chat's skill-list refresh, which the same app load starts (short: wait for it, a few seconds at most).
    await r.fetching;
    for (const end = Date.now() + REFRESH_WAIT_MS; r.lock.holds('refresh') && Date.now() < end; ) await new Promise((res) => setTimeout(res, 50));
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
    } else await this.agentsMove(id);
    this.emitStatusSoon(id);
    return result;
  }

  /** Runs `fn` as a commit-message proposal of the vault: `isProposing` is true meanwhile. */
  async proposing<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.proposals.set(id, (this.proposals.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.proposals.get(id) ?? 1) - 1;
      if (n > 0) this.proposals.set(id, n);
      else this.proposals.delete(id);
    }
  }

  isProposing(id: string): boolean {
    return this.proposals.has(id);
  }

  /** The last agents move of this vault, if any (replayed to a client that connects later). */
  lastAgentsMove(id: string): (AgentsMove & { at: number }) | undefined {
    return this.rt.get(id)?.lastMove;
  }

  /**
   * Moves the vault to the `.agents` standard (after clone, pull, open), under the exclusive lock the
   * caller holds; never in conflict. Leaves uncommitted changes and announces them.
   */
  private async agentsMove(id: string) {
    const r = this.runtime(id);
    if (r.state !== 'ready' || r.conflict) return;
    const repo = this.repo(this.config(id));
    try {
      await restageSkillLink(repo);
      const scan = await scanLegacy(repo.rootDir);
      if (!hasLegacy(scan) || JSON.stringify(scan) === r.legacySeen) return;
      const move = await migrateToAgents(repo);
      r.legacySeen = JSON.stringify(await scanLegacy(repo.rootDir));
      if (isEmptyMove(move)) return;
      r.lastMove = { ...move, at: Date.now() };
      this.emit(id, { type: 'agents-move', ...r.lastMove });
    } catch (e) {
      console.warn(`agents move of ${id} failed:`, (e as Error).message);
    }
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

  private repo(v: StoredVault, timeoutMs?: number): Repo {
    return new Repo(this.cloneDir(v.id), v.branch, v.root, { identity: this.env.identity, token: this.env.githubToken?.(), timeoutMs });
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
    r.pullError = undefined;
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
        await this.agentsMove(v.id);
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

/**
 * Where an editor upload for `note` (`dir/stem.md`) goes: the note's own folder. It is in one when the
 * folder carries its name (case-insensitive) or it is the folder's `index.md`; otherwise it must move
 * into `dir/stem/` first.
 */
export function attachmentFolder(note: string): { folder: string; move: boolean } {
  const slash = note.lastIndexOf('/');
  const dir = slash < 0 ? '' : note.slice(0, slash);
  const stem = note.slice(slash + 1).replace(/\.md$/i, '');
  const own = stem.toLowerCase() === 'index' || dir.slice(dir.lastIndexOf('/') + 1).toLowerCase() === stem.toLowerCase();
  if (own) return { folder: dir, move: false };
  return { folder: dir ? `${dir}/${stem}` : stem, move: true };
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

/** An upload's file name: a new-file name without folders, and nothing that breaks a `![[name]]` embed. */
function checkUploadName(name: string) {
  if (name.includes('/') || name.includes('\\')) throw new HttpError(400, 'An upload name must not contain a folder', 'bad-name');
  if (name.startsWith('.')) throw new HttpError(400, 'An upload name must not start with a dot', 'bad-name');
  if (/[#^[\]|]/.test(name)) throw new HttpError(400, `"${name}" contains a character that breaks links (#^[]|)`, 'bad-name');
  checkNewName(name);
  if (!isUploadable(name)) throw new HttpError(415, 'Only JPEG, PNG, GIF, WebP and PDF can be uploaded.', 'not-uploadable');
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
