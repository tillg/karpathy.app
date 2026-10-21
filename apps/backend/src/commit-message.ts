import type { Change } from '@karpathy/shared';
import type { ConfigStore } from './config-store.js';
import type { Harness } from './harness/opencode.js';
import type { Vaults } from './vaults.js';
import { prompt } from '../../../prompts/load.js';

export const MAX_DIFF = 32 * 1024;
const TIMEOUT_MS = 15_000;

const COMMIT_REQUEST = prompt('commit-message-request');

export const fallbackMessage = (n: number) => `Update ${n} file${n === 1 ? '' : 's'}`;

/** The user message of the commit-message turn: the changed files, the stat and the diff (cut at MAX_DIFF). */
export function commitRequest(files: Pick<Change, 'kind' | 'path'>[], stat: string, diff: string): string {
  return COMMIT_REQUEST.render({
    files: files.map((f) => `${f.kind}: ${f.path}`).join('\n'),
    stat: stat.trim(),
    diff: diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff,
  });
}

export interface CommitMessages {
  propose(vaultId: string): Promise<{ message: string; fallback: boolean }>;
}

/**
 * Commit message proposal (mvp §2.4) via a throwaway opencode session with the tool-less
 * `commit-message` agent; the session is deleted afterwards so the chat list stays clean.
 * No vault lock: it touches no files. Failure or >15 s → "Update N files".
 */
export class OpencodeCommitMessages implements CommitMessages {
  constructor(
    private readonly vaults: Vaults,
    private readonly store: ConfigStore,
    private readonly harness: Harness,
    private readonly dirOf: (vaultId: string) => string,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  /** Marked as running, so a skill-list refresh (which ends every opencode session of the vault) waits. */
  propose(vaultId: string) {
    return this.vaults.proposing(vaultId, () => this.run(vaultId));
  }

  private async run(vaultId: string) {
    const { files, stat, diff: full } = await this.vaults.fullDiff(vaultId);
    const fallback = { message: fallbackMessage(files.length), fallback: true };
    if (files.length === 0 || this.vaults.harnessConfigIn(vaultId)) return fallback;
    // Possible secrets never reach the model (#167); without a scan, no diff does.
    const diff = await this.vaults.redactSecrets(vaultId, full).catch((e: Error) => {
      console.warn(`secret scan for the commit message of ${vaultId} failed:`, e.message);
      return '[diff left out: the secret scan could not run]';
    });
    const dir = this.dirOf(vaultId);
    const text = commitRequest(files, stat, diff);
    let sessionId: string | undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const work = (async () => {
        sessionId = await this.harness.createSession(dir, 'commit message');
        return this.harness.promptSync(dir, sessionId, { text, agent: 'commit-message', model: this.store.get().settings.model }, ctrl.signal);
      })();
      const aborted = new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('timeout'))));
      const message = clean(await Promise.race([work, aborted]));
      return message ? { message, fallback: false } : fallback;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
      if (sessionId) {
        const id = sessionId;
        // A timed-out turn may still be running: stop it, then drop the session.
        await this.harness.abort(dir, id).catch(() => undefined);
        await this.harness.deleteSession(dir, id).catch(() => undefined);
      }
    }
  }
}

function clean(s: string): string {
  return s.replace(/^```\w*\n?|\n?```$/g, '').trim();
}
