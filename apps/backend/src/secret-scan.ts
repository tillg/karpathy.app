import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SecretFinding } from '@karpathy/shared';

/**
 * gitleaks' own rules, whatever a vault carries: a `.gitleaks.toml` in the vault (written by the AI, or arriving
 * with an ingested mail) must not switch them off.
 */
const DEFAULT_CONFIG = '[extend]\nuseDefault = true\n';

/** The masked hint shows the first 15 % of a secret (gitleaks' partial redaction), at most four characters. */
const SHOWN_SHARE = 0.15;
const SHOWN_CHARS = 4;

/** `file` of a finding in the commit message (not a vault path). */
export const MESSAGE_FILE = 'Commit message';
/** Rule of a changed file too large to scan: a finding the user can acknowledge, never a silent skip. */
export const TOO_LARGE_RULE = 'too-large-to-scan';
/** Same as the upload cap (50 MB per file). */
export const MAX_SCAN_BYTES = 50 * 1024 * 1024;

const IGNORE_FILE = '.gitleaksignore';

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  StartLine: number;
  File: string;
  Secret: string;
}

/** One changed file: its new blob, and the blob it replaces (modified or renamed), if any. */
interface Change {
  path: string;
  sha: string;
  size: number;
  base?: { path: string; sha: string; size: number };
}

/** A gitleaks hit, with the secret in clear (it never leaves this module except through `secretsInChanges`). */
interface Hit {
  side: 'new' | 'old' | 'message';
  path: string;
  rule: string;
  description: string;
  line: number;
  secret: string;
}

/**
 * Secret scan with the pinned gitleaks (deploy/gitleaks/install.sh, #141). Paths in the findings are repo-relative.
 * Fails closed: a scan that can't run, or that gitleaks reports as partial, throws instead of reporting clean.
 *
 * It scans file *contents*, not a diff: every changed blob (as git stores it, no attributes or filters applied) is
 * exported to a temp dir and scanned with `gitleaks dir`, so binary files, NUL bytes and `-diff` attributes can't
 * hide a token. A secret already in the replaced blob (same rule, same secret) is not reported again.
 */
export class SecretScanner {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  /** Fingerprints are keyed hashes: stable while the backend runs, meaningless outside it. */
  private readonly key = randomBytes(32);

  constructor({ bin = 'gitleaks', timeoutMs = 120_000, maxBytes = MAX_SCAN_BYTES }: { bin?: string; timeoutMs?: number; maxBytes?: number } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  /**
   * What `git commit` would record: the staged changes against HEAD, and `message` if given. The
   * `.gitleaksignore` that applies is HEAD's: one the same commit creates or extends takes effect only once committed.
   */
  async scanStaged(repoDir: string, { message }: { message?: string } = {}): Promise<SecretFinding[]> {
    const head = await this.revParse(repoDir, 'HEAD');
    const base = head ?? (await this.emptyTree(repoDir));
    const changes = await this.changes(repoDir, ['diff', '--cached', base]);
    return this.findings(repoDir, changes, message, head);
  }

  /** One commit's own changes (against its first parent) and its message; `ignoreRev`'s `.gitleaksignore` applies. */
  async scanCommit(repoDir: string, commit: string, ignoreRev: string | null): Promise<SecretFinding[]> {
    const parent = (await this.revParse(repoDir, `${commit}^`)) ?? (await this.emptyTree(repoDir));
    const changes = await this.changes(repoDir, ['diff', parent, commit]);
    const message = (await this.git(repoDir, ['log', '-1', '--format=%B', commit])).toString('utf8');
    return this.findings(repoDir, changes, message, ignoreRev);
  }

  /**
   * Every secret in the uncommitted changes under `pathspec`, old and new side, no ignore list: to take them out of
   * a diff before it leaves the server (#167). Stages into a temp copy of the index; the real index is not touched.
   */
  async secretsInChanges(repoDir: string, pathspec: string): Promise<string[]> {
    const tmp = await mkdtemp(join(tmpdir(), 'kai-scan-idx-'));
    try {
      const index = join(tmp, 'index');
      const gitDir = (await this.git(repoDir, ['rev-parse', '--absolute-git-dir'])).toString('utf8').trim();
      await copyFile(join(gitDir, 'index'), index).catch(() => undefined);
      const env = { GIT_INDEX_FILE: index };
      await this.git(repoDir, ['add', '-A', '--', pathspec], env);
      const head = await this.revParse(repoDir, 'HEAD');
      const changes = await this.changes(repoDir, ['diff', '--cached', head ?? (await this.emptyTree(repoDir))], env);
      const { hits } = await this.run(repoDir, changes);
      return [...new Set(hits.map((h) => h.secret).filter(Boolean))];
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async findings(repoDir: string, changes: Change[], message: string | undefined, ignoreRev: string | null): Promise<SecretFinding[]> {
    const { hits, tooLarge } = await this.run(repoDir, changes, message);
    const ignored = await this.ignoreList(repoDir, ignoreRev);
    const baseOf = new Map(changes.map((c) => [c.path, c.base?.path]));
    const known = new Set(hits.filter((h) => h.side === 'old').map((h) => `${h.path}\0${h.rule}\0${h.secret}`));
    const out: SecretFinding[] = [];
    for (const h of hits) {
      if (h.side === 'old') continue;
      if (h.side === 'new') {
        const base = baseOf.get(h.path);
        if (base !== undefined && known.has(`${base}\0${h.rule}\0${h.secret}`)) continue;
        if (ignored.has(`${h.path}:${h.rule}:${h.line}`)) continue;
      }
      const file = h.side === 'message' ? MESSAGE_FILE : h.path;
      out.push({ file, line: h.line, rule: h.rule, description: h.description, masked: mask(h.secret), fingerprint: this.fingerprint(file, h.rule, h.secret) });
    }
    for (const c of tooLarge)
      out.push({ file: c.path, line: 0, rule: TOO_LARGE_RULE, description: `File too large for the secret scan (over ${Math.round(this.maxBytes / 1024 / 1024)} MB)`, masked: '', fingerprint: this.fingerprint(c.path, TOO_LARGE_RULE, c.sha) });
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  private fingerprint(file: string, rule: string, secret: string): string {
    return createHmac('sha256', this.key).update(`${file}\0${rule}\0${secret}`).digest('hex').slice(0, 32);
  }

  /** `.gitleaksignore` entries (`file:rule:line`, gitleaks' fingerprint format) as committed in `rev`. */
  private async ignoreList(repoDir: string, rev: string | null): Promise<Set<string>> {
    if (!rev) return new Set();
    const r = await this.git(repoDir, ['cat-file', 'blob', `${rev}:${IGNORE_FILE}`]).catch(() => null);
    if (!r) return new Set();
    return new Set(r.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }

  /** Changed files of `git <diffArgs>` (renames detected; deletions and submodules have nothing to scan). */
  private async changes(repoDir: string, diffArgs: string[], env: Record<string, string> = {}): Promise<Change[]> {
    const [cmd, ...rest] = diffArgs;
    const out = (await this.git(repoDir, [cmd!, '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', ...rest], env)).toString('utf8');
    const parts = out.split('\0');
    const raw: { path: string; sha: string; base?: { path: string; sha: string } }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const meta = parts[i]!;
      if (!meta.startsWith(':')) continue;
      const [srcMode, dstMode, srcSha, dstSha, status = ''] = meta.slice(1).split(' ');
      const kind = status[0];
      const first = parts[++i]!;
      const second = kind === 'R' || kind === 'C' ? parts[++i]! : undefined;
      if (kind === 'D' || dstMode === '160000' || /^0+$/.test(dstSha!)) continue;
      const path = second ?? first;
      const hasBase = (kind === 'M' || kind === 'T' || kind === 'R') && srcMode !== '160000' && !/^0+$/.test(srcSha!);
      raw.push({ path, sha: dstSha!, ...(hasBase ? { base: { path: first, sha: srcSha! } } : {}) });
    }
    const sizes = await this.sizes(repoDir, [...raw.map((c) => c.sha), ...raw.flatMap((c) => (c.base ? [c.base.sha] : []))]);
    return raw.map(({ path, sha, base }): Change => ({ path, sha, size: sizes.get(sha)!, ...(base ? { base: { ...base, size: sizes.get(base.sha)! } } : {}) }));
  }

  private async sizes(repoDir: string, shas: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!shas.length) return out;
    const r = (await this.git(repoDir, ['cat-file', '--batch-check'], {}, `${shas.join('\n')}\n`)).toString('utf8');
    for (const line of r.split('\n').filter(Boolean)) {
      const [sha, type, size] = line.split(' ');
      if (type !== 'blob') throw new Error(`secret scan failed: object ${sha} is ${type ?? 'unreadable'}`);
      out.set(sha!, Number(size));
    }
    for (const s of shas) if (!out.has(s)) throw new Error(`secret scan failed: object ${s} missing`);
    return out;
  }

  /** Exports the blobs (and the message) to a temp dir and runs `gitleaks dir` over it. */
  private async run(repoDir: string, changes: Change[], message?: string): Promise<{ hits: Hit[]; tooLarge: Change[] }> {
    const tooLarge = changes.filter((c) => c.size > this.maxBytes);
    const tmp = await mkdtemp(join(tmpdir(), 'kai-scan-'));
    try {
      // src/ holds only n/ (new blobs), o/ (replaced blobs) and m/ (the message): no `.gitleaksignore` or
      // `.gitleaks.toml` of the vault ever sits where gitleaks looks for one. ign/ is the (empty) ignore dir.
      const src = join(tmp, 'src');
      await mkdir(join(tmp, 'ign'), { recursive: true });
      await mkdir(src, { recursive: true });
      const targets: { sha: string; file: string }[] = [];
      for (const c of changes) {
        if (c.size <= this.maxBytes) targets.push({ sha: c.sha, file: join(src, 'n', c.path) });
        if (c.base && c.base.size <= this.maxBytes) targets.push({ sha: c.base.sha, file: join(src, 'o', c.base.path) });
      }
      await this.exportBlobs(repoDir, targets);
      if (message !== undefined) {
        await mkdir(join(src, 'm'), { recursive: true });
        await writeFile(join(src, 'm', 'COMMIT_EDITMSG'), message);
      }
      const raw = await this.gitleaks(tmp);
      const hits: Hit[] = [];
      for (const f of raw) {
        const rel = f.File.replace(/^(\.\/)?src\//, '');
        const side = rel.startsWith('n/') ? 'new' : rel.startsWith('o/') ? 'old' : rel.startsWith('m/') ? 'message' : null;
        if (!side) throw new Error('secret scan failed: unexpected path in gitleaks report');
        hits.push({ side, path: rel.slice(2), rule: f.RuleID, description: f.Description, line: f.StartLine, secret: f.Secret });
      }
      return { hits, tooLarge };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async gitleaks(cwd: string): Promise<GitleaksFinding[]> {
    const args = [
      'dir', '--no-banner', '--no-color', '--log-level', 'warn',
      // A mail or web page can carry the marker next to a real token.
      '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path', 'ign',
      '--report-format', 'json', '--report-path', '-', '--exit-code', '0',
      'src',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, GITLEAKS_CONFIG_TOML: DEFAULT_CONFIG };
    delete env.GITLEAKS_CONFIG;
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(this.bin, args, { cwd, env, timeout: this.timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`secret scan failed: ${(errOut || err.message).toString().trim().split('\n').pop()}`));
        else resolve({ stdout: out, stderr: errOut });
      });
    });
    // gitleaks logs a file it skipped or couldn't read and still exits 0 with a report: fail closed on any
    // warning or error except the "leaks found" summary.
    const bad = stderr.split('\n').find((l) => /\b(WRN|ERR|FTL|PNC)\b/.test(l) && !/\bleaks found: \d+/.test(l));
    if (bad) throw new Error(`secret scan failed: ${bad.trim()}`);
    try {
      return stdout.trim() ? (JSON.parse(stdout) as GitleaksFinding[]) : [];
    } catch {
      throw new Error('secret scan failed: unreadable gitleaks report');
    }
  }

  /** Writes each blob's raw content (no attributes, no filters) to its file, one `git cat-file --batch` for all. */
  private async exportBlobs(repoDir: string, targets: { sha: string; file: string }[]): Promise<void> {
    if (!targets.length) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: repoDir, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      let i = 0;
      let header: { size: number } | null = null;
      let chunks: Buffer[] = [];
      let have = 0;
      let failed = false;
      let writing = Promise.resolve();
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        child.kill('SIGKILL');
        reject(e);
      };
      const take = (n: number): Buffer => {
        const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
        chunks = n < all.length ? [all.subarray(n)] : [];
        have = all.length - n;
        return all.subarray(0, n);
      };
      child.stdout.on('data', (d: Buffer) => {
        chunks.push(d);
        have += d.length;
        for (;;) {
          if (!header) {
            const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
            chunks = [joined];
            const nl = joined.indexOf(0x0a);
            if (nl < 0) return;
            const line = take(nl + 1).toString('utf8').trim();
            const m = /^[0-9a-f]+ blob (\d+)$/.exec(line);
            if (!m) return fail(new Error(`secret scan failed: unexpected object ${line}`));
            header = { size: Number(m[1]) };
          }
          if (have < header.size + 1) return;
          const body = Buffer.from(take(header.size + 1).subarray(0, header.size));
          const t = targets[i++];
          header = null;
          if (!t) return fail(new Error('secret scan failed: unexpected git output'));
          writing = writing.then(async () => {
            await mkdir(dirname(t.file), { recursive: true });
            await writeFile(t.file, body);
          });
          writing.catch((e: Error) => fail(e));
        }
      });
      child.stderr.resume();
      child.on('error', (e) => fail(e));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0 || i !== targets.length) return fail(new Error(`secret scan failed: git cat-file exited ${code}`));
        writing.then(resolve, (e: Error) => fail(e));
      });
      child.stdin.end(`${targets.map((t) => t.sha).join('\n')}\n`);
    });
  }

  private async revParse(repoDir: string, rev: string): Promise<string | null> {
    const r = await this.git(repoDir, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]).catch(() => null);
    return r ? r.toString('utf8').trim() : null;
  }

  private async emptyTree(repoDir: string): Promise<string> {
    return (await this.git(repoDir, ['hash-object', '-t', 'tree', '--stdin'], {}, '')).toString('utf8').trim();
  }

  /** git with the backend's settings; a non-zero exit rejects. */
  private git(repoDir: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd: repoDir, env: { ...gitEnv(), ...env }, encoding: 'buffer', timeout: this.timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`secret scan failed: git ${args[0]}: ${errOut.toString('utf8').trim() || err.message}`));
        else resolve(out);
      });
      if (input !== undefined) child.stdin?.end(input);
    });
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // The vault clones live on a shared volume, symlinks are plain files there (same as runGit).
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    GIT_CONFIG_KEY_1: 'core.symlinks',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

/** First characters of a secret (at most four, at most 15 % of it) and `…`. */
function mask(secret: string): string {
  return `${secret.slice(0, Math.min(SHOWN_CHARS, Math.floor(secret.length * SHOWN_SHARE)))}…`;
}
