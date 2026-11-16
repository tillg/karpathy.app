import { execFile } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(`git ${args[0]} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`);
  }
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  /** GitHub token; sent as an http header via env, never written to .git/config. */
  token?: string;
  identity: GitIdentity;
  /** Kills git after this long; the call then fails. */
  timeoutMs?: number;
}

/** Runs git in one working copy. Only the backend runs git (mvp §3.2). */
export class Git {
  constructor(
    readonly cwd: string,
    private readonly opts: GitOptions,
  ) {}

  run(args: string[], { input, allowFail = false }: { input?: string; allowFail?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return runGit(this.cwd, args, this.opts, input).then((r) => {
      if (r.code !== 0 && !allowFail) throw new GitError(args, r.code, r.stderr, r.stdout);
      return r;
    });
  }

  async out(args: string[]): Promise<string> {
    return (await this.run(args)).stdout;
  }

  /** Content of `rev:path`, or null when it doesn't exist there. */
  async show(rev: string, path: string): Promise<Buffer | null> {
    const r = await runGit(this.cwd, ['show', `${rev}:${path}`], this.opts, undefined, true);
    return r.code === 0 ? r.buf : null;
  }
}

/**
 * Where each vault's git dir lives (#175): `<gitdirs>/<id>`, outside its working tree `<vaults>/<id>`. The terminal
 * writes the working trees but mounts the git dirs read-only, so the backend never lets git discover a `.git` in a
 * tree (the terminal could plant one): `repoEnv` names both dirs explicitly. Registered by Vaults at startup.
 */
const gitDirs = new Map<string, string>();

export function registerGitDirs(vaultsDir: string, gitdirsDir: string) {
  gitDirs.set(resolve(vaultsDir), resolve(gitdirsDir));
}

/** The vault clone `cwd` is in, as git env (GIT_DIR, GIT_WORK_TREE); empty outside every registered clone. */
export function repoEnv(cwd: string): NodeJS.ProcessEnv {
  const abs = resolve(cwd);
  for (const [vaults, gitdirs] of gitDirs) {
    if (!abs.startsWith(vaults + sep)) continue;
    const id = abs.slice(vaults.length + 1).split(sep)[0]!;
    // App state next to the clones (.preflight, .open-page, …) is no clone.
    if (!id || id.startsWith('.')) return {};
    return { GIT_DIR: join(gitdirs, id), GIT_WORK_TREE: join(vaults, id) };
  }
  return {};
}

/**
 * The config every backend git command runs with (command-line precedence, above the clone's own): any UID may own the
 * shared clones; symlinks check out as plain files (opencode's containment check is lexical, so a symlink in a vault
 * could reach another vault, spike-opencode.md); no hooks and no fsmonitor command, whatever a repo says. `extra`
 * keys are appended.
 */
export function safeGitEnv(extra: [string, string][] = []): NodeJS.ProcessEnv {
  // ignoreSubmodules: a repo nested in a vault (the terminal can `git init` one) is never entered, so its config can't
  // run anything (env config reaches child gits too).
  const pairs: [string, string][] = [['safe.directory', '*'], ['core.symlinks', 'false'], ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['diff.ignoreSubmodules', 'all'], ...extra];
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** How long a timed-out git gets to clean up after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export function runGit(
  cwd: string,
  args: string[],
  opts: GitOptions,
  input?: string,
  binary = false,
): Promise<{ code: number; stdout: string; stderr: string; buf: Buffer }> {
  const auth: [string, string][] = opts.token
    ? [['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`]]
    : [];
  const env: NodeJS.ProcessEnv = {
    ...safeGitEnv(auth),
    ...repoEnv(cwd),
    GIT_TERMINAL_PROMPT: '0',
    // Status polling must not take index.lock, or it races with discard/commit.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: opts.identity.name,
    GIT_AUTHOR_EMAIL: opts.identity.email,
    GIT_COMMITTER_NAME: opts.identity.name,
    GIT_COMMITTER_EMAIL: opts.identity.email,
  };
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: binary ? '' : stdout.toString('utf8'), stderr: stderr.toString('utf8'), buf: stdout });
      },
    );
    // SIGTERM first: git removes its .lock files on it (not on SIGKILL), else a later fetch or pull
    // fails on "cannot lock ref". Helpers (remote-https, upload-pack) may hold the pipes open after
    // git dies: after a grace period kill and close them too, so the call returns (the orphaned
    // helpers die on the broken pipe).
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = opts.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, KILL_GRACE_MS);
    }, opts.timeoutMs) : undefined;
    if (input !== undefined) child.stdin?.end(input);
  });
}
