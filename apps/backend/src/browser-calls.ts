import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBrowserCallResult, type BrowserCall, type VaultEvent } from '@karpathy/shared';
import { HttpError } from './vaults.js';

/**
 * Browser calls (#151): a browser tool (deploy/opencode/tools/user_location.ts) waits for
 * `<vaults>/.browser-calls/<chat>/<call>.json` (session id = chat id, both as `fileKey`); the backend announces the
 * call on the vault event stream, the answering tab POSTs its result, and the backend writes that file once. Outside
 * every git clone, next to `.open-page`.
 */
export const BROWSER_CALLS_DIR = '.browser-calls';

/** The tool's wait (deploy/opencode/lib/browser-call.ts BROWSER_CALL_TIMEOUT_MS, same value: the images share no code). */
const TIMEOUT_MS = 90_000;
/** After the tool's deadline: then the call is surely over. */
const GRACE_MS = 5_000;

/** An id as a file name, as the tool computes it (deploy/opencode/lib/browser-call.ts `fileKey`). */
const fileKey = (id: string) => Buffer.from(id).toString('base64url');
/** Providers may reuse call ids (`call_0`): a call is unique per vault and chat only. */
const key = (vaultId: string, chatId: string, callId: string) => JSON.stringify([vaultId, chatId, callId]);

interface Pending extends BrowserCall {
  vaultId: string;
  answered: boolean;
  timer: NodeJS.Timeout;
}

export class BrowserCalls {
  private calls = new Map<string, Pending>();

  constructor(
    private vaultsDir: string,
    private emit: (vaultId: string, e: VaultEvent) => void,
    private opts: { timeoutMs?: number; graceMs?: number } = {},
  ) {}

  private dir(chatId: string) {
    return join(this.vaultsDir, BROWSER_CALLS_DIR, fileKey(chatId));
  }

  /** A browser tool's part is running: announce it once (parts update several times). */
  open(c: Omit<BrowserCall, 'deadline'> & { vaultId: string }): void {
    const k = key(c.vaultId, c.chatId, c.callId);
    if (this.calls.has(k)) return;
    const timeout = this.opts.timeoutMs ?? TIMEOUT_MS;
    const timer = setTimeout(() => this.close(c.vaultId, c.chatId, c.callId), timeout + (this.opts.graceMs ?? GRACE_MS));
    const p: Pending = { ...c, deadline: Date.now() + timeout, answered: false, timer };
    this.calls.set(k, p);
    this.emit(c.vaultId, { type: 'browser-call', call: this.public(p) });
  }

  /** The answering tab's result: written once for the waiting tool. */
  async answer(vaultId: string, chatId: string, callId: string, body: unknown): Promise<void> {
    const p = this.calls.get(key(vaultId, chatId, callId));
    if (!p) throw new HttpError(404, 'no such browser call');
    if (p.answered) throw new HttpError(409, 'this browser call was already answered');
    const result = parseBrowserCallResult(p.tool, body);
    if (!result) throw new HttpError(400, `not a valid ${p.tool} result`);
    p.answered = true;
    try {
      const dest = join(this.dir(chatId), `${fileKey(callId)}.json`);
      await mkdir(this.dir(chatId), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(result));
      await rename(tmp, dest);
    } catch (e) {
      p.answered = false;
      throw e;
    }
    this.emit(vaultId, { type: 'browser-call-done', callId });
  }

  /** The call is over (part done, deadline): drop it and any answer the tool never read. */
  close(vaultId: string, chatId: string, callId: string): void {
    const k = key(vaultId, chatId, callId);
    const p = this.calls.get(k);
    if (!p) return;
    clearTimeout(p.timer);
    this.calls.delete(k);
    if (!p.answered) this.emit(vaultId, { type: 'browser-call-done', callId });
    void rm(join(this.dir(chatId), `${fileKey(callId)}.json`), { force: true });
  }

  /** What a newly connected vault event stream gets first, so a reloaded tab still answers. */
  pending(vaultId: string): BrowserCall[] {
    return [...this.calls.values()].filter((p) => p.vaultId === vaultId && !p.answered).map((p) => this.public(p));
  }

  /** The chat is deleted: its calls and answer files go with it. */
  async removeChat(vaultId: string, chatId: string): Promise<void> {
    for (const p of [...this.calls.values()]) if (p.vaultId === vaultId && p.chatId === chatId) this.close(vaultId, chatId, p.callId);
    await rm(this.dir(chatId), { recursive: true, force: true });
  }

  /** The vault's turn ended (one turn at a time): its calls are over, those of subagent sessions included. */
  async closeVault(vaultId: string): Promise<void> {
    const chats = new Set([...this.calls.values()].filter((p) => p.vaultId === vaultId).map((p) => p.chatId));
    for (const chatId of chats) await this.removeChat(vaultId, chatId);
  }

  private public({ chatId, callId, tool, input, tabId, deadline }: Pending): BrowserCall {
    return { chatId, callId, tool, input, tabId, deadline };
  }
}
