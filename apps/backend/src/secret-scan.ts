import { execFile } from 'node:child_process';
import type { SecretFinding } from '@karpathy/shared';

/**
 * gitleaks' own rules, whatever a vault carries: a `.gitleaks.toml` in the vault (written by the AI, or arriving
 * with an ingested mail) must not switch them off.
 */
const DEFAULT_CONFIG = '[extend]\nuseDefault = true\n';

/** gitleaks' partial redaction: keeps the first 15 % of a secret; we show at most four characters of that. */
const REDACT_PERCENT = 85;
const SHOWN_CHARS = 4;

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  StartLine: number;
  File: string;
  Secret: string;
  Fingerprint: string;
}

/**
 * Secret scan of a commit's staged changes with the pinned gitleaks (deploy/gitleaks/install.sh, #141). Paths in the
 * findings are repo-relative. Fails closed: a scan that can't run throws instead of reporting a clean diff.
 */
export class SecretScanner {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor({ bin = 'gitleaks', timeoutMs = 120_000 }: { bin?: string; timeoutMs?: number } = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
  }

  async scanStaged(repoDir: string): Promise<SecretFinding[]> {
    const args = [
      'git', '--staged', '--no-banner', '--no-color', '--log-level', 'error',
      `--redact=${REDACT_PERCENT}`,
      // A mail or web page can carry the marker next to a real token.
      '--ignore-gitleaks-allow',
      // The vault's .gitleaksignore (fingerprints, repo root): a deliberate, reviewable allowlist.
      '--gitleaks-ignore-path', repoDir,
      '--report-format', 'json', '--report-path', '-', '--exit-code', '0',
      repoDir,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITLEAKS_CONFIG_TOML: DEFAULT_CONFIG,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      // The vault clones live on a shared volume (same as runGit).
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    };
    delete env.GITLEAKS_CONFIG;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(this.bin, args, { cwd: repoDir, env, timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) reject(new Error(`secret scan failed: ${(errOut || err.message).toString().trim().split('\n').pop()}`));
        else resolve(out);
      });
    });
    let raw: GitleaksFinding[];
    try {
      raw = stdout.trim() ? (JSON.parse(stdout) as GitleaksFinding[]) : [];
    } catch {
      throw new Error('secret scan failed: unreadable gitleaks report');
    }
    return raw
      .map((f) => ({
        file: f.File,
        line: f.StartLine,
        rule: f.RuleID,
        description: f.Description,
        masked: mask(f.Secret),
        fingerprint: f.Fingerprint,
      }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
}

/** gitleaks' redacted secret (`abcd...`) → at most four characters and `…`. */
function mask(redacted: string): string {
  const kept = redacted.endsWith('...') ? redacted.slice(0, -3) : '';
  return `${kept.slice(0, SHOWN_CHARS)}…`;
}
