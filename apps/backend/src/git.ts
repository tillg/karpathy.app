import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** A clone's `.git` could make the backend's git run a command (#175): refused before git starts. */
export class UnsafeGitConfigError extends Error {}

/**
 * Local config keys the backend's git accepts; any other key is refused. Filters, textconv, fsmonitor, credential
 * helpers, editors and the like all need a key to run a command, and `include*` / `extensions.worktreeconfig` would add
 * config sources this check doesn't read. `*` stands for one subsection name.
 */
const SAFE_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|longpaths|compression|checkstat|trustctime|sparsecheckout|sparsecheckoutcone)$/,
  /^extensions\.(partialclone|objectformat)$/,
  /^remote\.[^]*\.(url|pushurl|fetch|tagopt|prune|mirror|skipfetchall|promisor|partialclonefilter)$/,
  // No branch key takes a command (editors add their own, e.g. branch.main.vscode-merge-base).
  /^branch\./,
  /^(user\.(name|email)|pull\.(rebase|ff)|fetch\.prune|push\.(default|autosetupremote)|init\.defaultbranch|rebase\.autostash|merge\.conflictstyle|gc\.auto|color\.ui)$/,
];

/** The `.git` git would use from `cwd` (the first one up the tree), or null. */
function findDotGit(cwd: string): string | null {
  for (let d = cwd; ; d = dirname(d)) {
    const p = join(d, '.git');
    try {
      lstatSync(p);
      return p;
    } catch { /* keep looking */ }
    if (dirname(d) === d) return null;
  }
}

const checked = new Map<string, string>();

/** Throws UnsafeGitConfigError when the repo around `cwd` could run a command through its local config. */
export function assertSafeRepo(cwd: string) {
  const dotGit = findDotGit(cwd);
  if (!dotGit) return;
  const st = lstatSync(dotGit);
  if (!st.isDirectory()) throw new UnsafeGitConfigError(`${dotGit} is not a folder (a link or a gitdir file): the app only runs git in plain clones`);
  const config = join(dotGit, 'config');
  let cst;
  try {
    cst = statSync(config);
  } catch {
    return;
  }
  // Re-read only when the file changed; git parses it (the backend must agree with git on what is set).
  const stamp = `${cst.ino}:${cst.size}:${cst.mtimeMs}`;
  if (checked.get(config) === stamp) return;
  const names = execFileSync('git', ['config', '--file', config, '--list', '--name-only', '-z'], { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' } })
    .split('\0').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const bad = names.find((n) => !SAFE_KEYS.some((re) => re.test(n)));
  if (bad) throw new UnsafeGitConfigError(`${config} sets ${bad}, which the app doesn't run git with (it could run a command). Remove it, e.g. in the terminal: git config --unset ${bad}`);
  checked.set(config, stamp);
}

/**
 * The config every backend git command runs with (command-line precedence, above the clone's own): any UID may own the
 * shared clones; symlinks check out as plain files (opencode's containment check is lexical, so a symlink in a vault
 * could reach another vault, spike-opencode.md); and since the terminal (#175) can write `.git`, no hooks and no
 * fsmonitor command, whatever the clone says. `extra` keys are appended.
 */
export function safeGitEnv(extra: [string, string][] = []): NodeJS.ProcessEnv {
  const pairs: [string, string][] = [['safe.directory', '*'], ['core.symlinks', 'false'], ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ...extra];
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
    GIT_TERMINAL_PROMPT: '0',
    // Status polling must not take index.lock, or it races with discard/commit.
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: opts.identity.name,
    GIT_AUTHOR_EMAIL: opts.identity.email,
    GIT_COMMITTER_NAME: opts.identity.name,
    GIT_COMMITTER_EMAIL: opts.identity.email,
  };
  try {
    assertSafeRepo(cwd);
  } catch (e) {
    return Promise.reject(e);
  }
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
