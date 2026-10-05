import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { uploadMime, type ChatDetail, type ChatEvent, type ChatSummary, type TurnState } from '@karpathy/shared';
import type { ConfigStore } from './config-store.js';
import type { Harness } from './harness/opencode.js';
import type { HarnessEvent } from './harness/map.js';
import type { Release } from './lock.js';
import { HttpError, type Vaults } from './vaults.js';

type Listener = (e: ChatEvent) => void;

interface Turn {
  chatId: string;
  text: string;
  /** Vault paths of files sent with the prompt (uploaded before); checked when the turn starts. */
  attachments?: string[];
}

interface Running {
  chatId: string;
  release: Release;
  /** Set once the prompt call returned or opencode reported busy; guards against stale idles. */
  started: boolean;
  /** The harness event stream dropped during the turn (e.g. opencode restarted, #28). */
  interrupted?: boolean;
  readonly: boolean;
  startedAt: number;
  /** False while still waiting for the lock (the slot is only reserved). */
  holding: boolean;
}

interface VaultChats {
  queue: Turn[];
  running: Running | null;
  /** Sessions found busy at startup that we didn't start; the lock is held until they're idle. */
  adopted: { ids: Set<string>; release: Release } | null;
  unsubscribe: () => void;
  /** Directory the subscription is for; a vault-root change needs a new one. */
  dir: string;
  listeners: Map<string, Set<Listener>>;
  poll?: NodeJS.Timeout;
}

/** Idle safety net for a missed event: poll opencode's busy list while a turn runs. */
const POLL_MS = 3000;

/**
 * Chats = opencode sessions, one vault each (mvp §3.2 Chat API). One running turn per vault;
 * more prompts queue. Every turn starts with a pull under the exclusive lock, then holds the
 * shared lock until opencode reports the session idle. Turns outlive client connections.
 */
export class ChatService {
  private v = new Map<string, VaultChats>();

  constructor(
    private readonly vaults: Vaults,
    private readonly store: ConfigStore,
    private readonly harness: Harness,
    /** The vaults dir as the harness sees it (`/vaults` in compose). */
    private readonly harnessVaultsDir: string,
  ) {}

  /** Opens one event subscription per ready vault; adopts turns still running in opencode. */
  async init(): Promise<void> {
    for (const vault of this.vaults.list()) if (vault.state === 'ready' || vault.state === 'conflict') await this.watch(vault.id);
  }

  private saveQueue(vaultId: string): Promise<void> {
    const q = this.v.get(vaultId)?.queue ?? [];
    return this.store
      .update((c) => {
        if (q.length) c.queued[vaultId] = q.map(({ chatId, text, attachments }) => ({ chatId, text, ...(attachments?.length ? { attachments } : {}) }));
        else delete c.queued[vaultId];
      })
      .catch(() => undefined);
  }

  /** Deletes every chat of a vault (it is being removed, #34). */
  async deleteAllChats(vaultId: string) {
    const dir = this.dir(vaultId);
    // A vault carrying harness config never reached opencode, so it has no chats to delete.
    if (!this.vaults.harnessConfigIn(vaultId))
      for (const s of await this.harness.listSessions(dir).catch(() => [])) await this.harness.deleteSession(dir, s.id).catch(() => undefined);
    this.vaultRemoved(vaultId);
    await this.store.update((c) => { delete c.queued[vaultId]; });
  }

  close() {
    for (const c of this.v.values()) {
      c.unsubscribe();
      clearInterval(c.poll);
    }
  }

  dir(vaultId: string): string {
    const vault = this.vaults.getVault(vaultId);
    return posix.join(this.harnessVaultsDir, vaultId, vault.root);
  }

  /**
   * `guard`: hold the lock while asking opencode for busy sessions (startup / vault ready),
   * so no exclusive op runs next to a turn left over from before a restart (mvp §2.4).
   */
  private async attach(vaultId: string, guard = false): Promise<VaultChats> {
    this.refuseUnsafe(vaultId);
    const dir = this.dir(vaultId);
    let c = this.v.get(vaultId);
    if (c && (c.dir === dir || c.running || c.queue.length)) return c;
    if (c) this.vaultRemoved(vaultId);
    c = { queue: [], running: null, adopted: null, listeners: new Map(), unsubscribe: () => undefined, dir };
    this.v.set(vaultId, c);
    c.unsubscribe = this.harness.subscribe(
      dir,
      (e) => this.onEvent(vaultId, e),
      // A pull may bring harness config in later; never (re)connect then.
      () => this.vaults.harnessConfigIn(vaultId) === null,
    );
    const lock = this.vaults.lock(vaultId);
    let release = guard ? await lock.acquireShared('turn') : null;
    let busy: string[];
    try {
      busy = await this.busyWithRetry(dir, guard ? 15 : 0);
    } catch (e) {
      release?.();
      // Another request may already use this entry (queued or running turn): keep it then.
      if (!c.running && c.queue.length === 0) this.vaultRemoved(vaultId);
      throw e;
    }
    if (busy.length > 0) {
      release ??= await lock.acquireShared('turn');
      c.adopted = { ids: new Set(busy), release };
      this.startPoll(vaultId);
    } else release?.();
    if (guard) {
      // Prompts queued before a restart run now (#37).
      const saved = this.store.get().queued[vaultId] ?? [];
      if (saved.length) {
        c.queue.push(...saved.filter((t) => !c.queue.some((q) => q.chatId === t.chatId)));
        void this.kick(vaultId);
      }
    }
    return c;
  }

  private refuseUnsafe(vaultId: string) {
    const found = this.vaults.harnessConfigIn(vaultId);
    if (found) throw new HttpError(409, unsafeMessage(found), 'unsafe-config');
  }

  /** Opens the vault's event subscription (startup, vault added or re-cloned). */
  async watch(vaultId: string): Promise<void> {
    await this.attach(vaultId, true).catch((e) => console.warn(`chat watch ${vaultId}:`, (e as Error).message));
  }

  /** Startup/ready (`retries` > 0): wait up to 30 s, then assume none. On a request: fail fast (503). */
  private async busyWithRetry(dir: string, retries: number): Promise<string[]> {
    for (let i = 0; ; i++) {
      try {
        return await this.harness.busySessions(dir);
      } catch (e) {
        if (retries === 0) throw aiUnavailable();
        // compose starts us after opencode is healthy; give a restarting opencode 30 s.
        if (i >= retries) {
          console.warn(`opencode unreachable, assuming no running turn in ${dir}:`, (e as Error).message);
          return [];
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async chats(vaultId: string): Promise<VaultChats> {
    const vault = this.vaults.getVault(vaultId);
    if (vault.state !== 'ready' && vault.state !== 'conflict') throw new HttpError(409, `vault is ${vault.state}`, 'not-ready');
    this.refuseUnsafe(vaultId);
    return this.attach(vaultId);
  }

  private async requireChat(vaultId: string, chatId: string) {
    await this.chats(vaultId);
    if (await this.harness.sessionExists(this.dir(vaultId), chatId)) return;
    if (!(await this.harness.health().catch(() => false)))
      throw aiUnavailable();
    throw new HttpError(404, `no such chat: ${chatId}`);
  }

  turnState(vaultId: string, chatId: string): TurnState {
    const c = this.v.get(vaultId);
    // A turn stays in the queue until it holds the lock (the pull may still be running).
    if (c?.queue.some((t) => t.chatId === chatId)) return 'queued';
    if (c?.running?.holding && c.running.chatId === chatId) return 'running';
    if (c?.adopted?.ids.has(chatId)) return 'running';
    return 'idle';
  }

  async list(vaultId: string): Promise<ChatSummary[]> {
    await this.chats(vaultId);
    return (await this.harness.listSessions(this.dir(vaultId))).map((s) => ({ ...s, turn: this.turnState(vaultId, s.id) }));
  }

  async create(vaultId: string): Promise<{ chatId: string }> {
    await this.chats(vaultId);
    return { chatId: await this.harness.createSession(this.dir(vaultId)) };
  }

  async get(vaultId: string, chatId: string): Promise<ChatDetail> {
    await this.requireChat(vaultId, chatId);
    const dir = this.dir(vaultId);
    const [messages, sessions] = await Promise.all([this.harness.messages(dir, chatId), this.harness.listSessions(dir)]);
    const queuedText = this.v.get(vaultId)?.queue.find((t) => t.chatId === chatId)?.text;
    return {
      id: chatId,
      title: sessions.find((s) => s.id === chatId)?.title ?? '',
      messages,
      turn: this.turnState(vaultId, chatId),
      ...(queuedText !== undefined ? { queuedText } : {}),
    };
  }

  async remove(vaultId: string, chatId: string): Promise<void> {
    await this.requireChat(vaultId, chatId);
    if (this.turnState(vaultId, chatId) !== 'idle') throw new HttpError(409, 'stop the running turn first', 'busy');
    await this.harness.deleteSession(this.dir(vaultId), chatId);
  }

  async prompt(vaultId: string, chatId: string, text: string, attachments?: string[]): Promise<void> {
    await this.requireChat(vaultId, chatId);
    const c = this.v.get(vaultId)!;
    if (this.turnState(vaultId, chatId) !== 'idle') throw new HttpError(409, 'this chat already has a turn running or queued', 'busy');
    c.queue.push({ chatId, text, ...(attachments?.length ? { attachments } : {}) });
    // 202 means the prompt survives a backend restart (#37).
    await this.saveQueue(vaultId);
    this.emit(vaultId, chatId, this.queuedEvent(vaultId));
    void this.titleFromFirstPrompt(vaultId, chatId, text || (attachments?.[0]?.split('/').pop() ?? ''));
    void this.kick(vaultId);
  }

  /** opencode names new sessions "New session - <date>"; name the chat after its first prompt (the UI cuts it with CSS; the cap only guards pasted walls of text). */
  private async titleFromFirstPrompt(vaultId: string, chatId: string, text: string) {
    const dir = this.dir(vaultId);
    const s = (await this.harness.listSessions(dir).catch(() => [])).find((x) => x.id === chatId);
    if (!s || !/^New session/.test(s.title)) return;
    const title = text.replace(/\s+/g, ' ').trim();
    await this.harness.setTitle(dir, chatId, title.length > 500 ? `${title.slice(0, 499)}…` : title).catch(() => undefined);
  }

  /** What a queued turn waits for: another chat's turn, or a sync (pull/commit/…). */
  private queuedEvent(vaultId: string): ChatEvent {
    const c = this.v.get(vaultId);
    const turnAhead = Boolean(c?.running?.holding || c?.adopted || this.vaults.lock(vaultId).busy === 'turn');
    return { type: 'turn', state: 'queued', waiting: turnAhead ? 'turn' : 'sync' };
  }

  async abort(vaultId: string, chatId: string): Promise<void> {
    await this.chats(vaultId);
    const c = this.v.get(vaultId)!;
    const i = c.queue.findIndex((t) => t.chatId === chatId);
    if (i >= 0) {
      c.queue.splice(i, 1);
      void this.saveQueue(vaultId);
      this.emit(vaultId, chatId, { type: 'turn', state: 'idle' });
      this.endStreams(vaultId, chatId);
      return;
    }
    // The lock is released once opencode reports the session idle.
    if (c.running?.chatId === chatId || c.adopted?.ids.has(chatId)) await this.harness.abort(this.dir(vaultId), chatId);
  }

  /**
   * Streams the mapped events of the running or queued turn; ends when the turn is idle.
   * Returns an unsubscribe function.
   */
  stream(vaultId: string, chatId: string, send: Listener, end: () => void): () => void {
    const state = this.v.has(vaultId) ? this.turnState(vaultId, chatId) : 'idle';
    const running = this.v.get(vaultId)?.running;
    if (state === 'queued') send(this.queuedEvent(vaultId));
    else send({ type: 'turn', state, ...(state === 'running' && running?.chatId === chatId && running.readonly ? { readonly: true } : {}) });
    if (state === 'idle') {
      end();
      return () => undefined;
    }
    const c = this.v.get(vaultId)!;
    let set = c.listeners.get(chatId);
    if (!set) c.listeners.set(chatId, (set = new Set()));
    const l: Listener = (e) => {
      send(e);
      if (e.type === 'turn' && e.state === 'idle') {
        set!.delete(l);
        end();
      }
    };
    set.add(l);
    return () => set!.delete(l);
  }

  // ---- turn lifecycle ----

  private async kick(vaultId: string) {
    const c = this.v.get(vaultId);
    if (!c || c.running || c.queue.length === 0) return;
    const turn = c.queue[0]!;
    // Reserve the slot before awaiting anything, so a second kick doesn't start a turn too.
    const running: Running = { chatId: turn.chatId, release: () => undefined, started: false, readonly: false, startedAt: Date.now(), holding: false };
    c.running = running;
    try {
      running.release = await this.vaults.lock(vaultId).exclusiveThenShared('turn', async () => {
        await this.vaults.pullUnlocked(vaultId);
      });
    } catch (e) {
      c.queue.shift();
      void this.saveQueue(vaultId);
      c.running = null;
      this.emit(vaultId, turn.chatId, { type: 'error', message: `pull before the turn failed: ${(e as Error).message}` });
      this.finish(vaultId, turn.chatId);
      return void this.kick(vaultId);
    }
    if (c.queue[0] !== turn) {
      // Aborted while waiting for the lock.
      running.release();
      c.running = null;
      return void this.kick(vaultId);
    }
    c.queue.shift();
    void this.saveQueue(vaultId);
    running.holding = true;
    // The pull may just have brought in opencode project config (#27): never send it the dir.
    const unsafe = this.vaults.harnessConfigIn(vaultId);
    if (unsafe) {
      this.emit(vaultId, turn.chatId, { type: 'error', message: unsafeMessage(unsafe) });
      return this.endTurn(vaultId);
    }
    // Checked now, not at prompt time: a file may be discarded while the turn waits.
    try {
      for (const path of turn.attachments ?? []) await this.vaults.checkAttachment(vaultId, path);
    } catch (e) {
      this.emit(vaultId, turn.chatId, { type: 'error', message: (e as Error).message });
      return this.endTurn(vaultId);
    }
    running.readonly = this.vaults.isConflict(vaultId);
    running.startedAt = Date.now();
    this.emit(vaultId, turn.chatId, { type: 'turn', state: 'running', ...(running.readonly ? { readonly: true } : {}) });
    const settings = this.store.get().settings;
    try {
      await this.harness.prompt(this.dir(vaultId), turn.chatId, {
        text: turn.text,
        agent: running.readonly ? 'vault-readonly' : 'vault',
        model: settings.model,
        // Sent with every turn, `false` included: opencode keeps the rule on the session.
        tools: { websearch: settings.webAccess, webfetch: settings.webAccess },
        ...(turn.attachments?.length ? { files: turn.attachments.map((path) => ({ path, mime: uploadMime(path), url: pathToFileURL(posix.join(this.dir(vaultId), path)).href })) } : {}),
      });
      running.started = true;
      this.startPoll(vaultId);
    } catch (e) {
      this.emit(vaultId, turn.chatId, { type: 'error', message: (e as Error).message });
      this.endTurn(vaultId);
    }
  }

  private endTurn(vaultId: string) {
    const c = this.v.get(vaultId);
    if (!c?.running) return;
    const { chatId, release, interrupted } = c.running;
    c.running = null;
    release();
    if (interrupted)
      this.emit(vaultId, chatId, { type: 'error', message: 'The AI service restarted during this turn, so the answer may be incomplete. Send the prompt again.' });
    this.finish(vaultId, chatId);
    void this.kick(vaultId);
  }

  private finish(vaultId: string, chatId: string) {
    this.emit(vaultId, chatId, { type: 'turn', state: 'idle' });
    this.endStreams(vaultId, chatId);
    this.stopPollIfIdle(vaultId);
  }

  private endStreams(vaultId: string, chatId: string) {
    this.v.get(vaultId)?.listeners.delete(chatId);
  }

  private startPoll(vaultId: string) {
    const c = this.v.get(vaultId);
    if (!c || c.poll) return;
    c.poll = setInterval(() => void this.resync(vaultId), POLL_MS);
  }

  private stopPollIfIdle(vaultId: string) {
    const c = this.v.get(vaultId);
    if (c && !c.running && !c.adopted && c.poll) {
      clearInterval(c.poll);
      c.poll = undefined;
    }
  }

  /** Reconciles with opencode's busy list (missed idle events, adopted turns after restart). */
  private async resync(vaultId: string) {
    const c = this.v.get(vaultId);
    if (!c) return;
    let busy: string[];
    try {
      busy = await this.harness.busySessions(this.dir(vaultId));
    } catch {
      return;
    }
    if (c.adopted) for (const id of [...c.adopted.ids]) if (!busy.includes(id)) this.endAdopted(vaultId, id);
    if (c.running?.started && !busy.includes(c.running.chatId) && Date.now() - c.running.startedAt > POLL_MS) this.endTurn(vaultId);
    this.stopPollIfIdle(vaultId);
  }

  private endAdopted(vaultId: string, chatId: string) {
    const c = this.v.get(vaultId);
    if (!c?.adopted?.ids.delete(chatId)) return;
    if (c.adopted.ids.size === 0) {
      c.adopted.release();
      c.adopted = null;
    }
    this.finish(vaultId, chatId);
  }

  private onEvent(vaultId: string, e: HarnessEvent) {
    const c = this.v.get(vaultId);
    if (!c) return;
    switch (e.type) {
      case 'file-edited':
        void this.vaults.markAiTouched(vaultId, [e.path]).catch(() => undefined);
        return;
      case 'status':
        if (!e.sessionId) {
          // The harness stream dropped and reconnects (opencode restart?).
          if (c.running?.holding) c.running.interrupted = true;
          return void this.resync(vaultId);
        }
        if (e.state === 'idle' && c.adopted?.ids.has(e.sessionId)) return this.endAdopted(vaultId, e.sessionId);
        if (c.running?.chatId !== e.sessionId) return;
        if (e.state === 'busy') c.running.started = true;
        else if (e.state === 'idle' && c.running.started) this.endTurn(vaultId);
        return;
      case 'message':
        return this.emit(vaultId, e.sessionId, { type: 'message', message: e.message });
      case 'part':
        return this.emit(vaultId, e.sessionId, { type: 'part', messageId: e.messageId, part: e.part });
      case 'text-delta':
        return this.emit(vaultId, e.sessionId, { type: 'text-delta', messageId: e.messageId, partId: e.partId, delta: e.delta });
      case 'error':
        if (!e.aborted) this.emit(vaultId, e.sessionId, { type: 'error', message: e.message });
        return;
    }
  }

  private emit(vaultId: string, chatId: string, e: ChatEvent) {
    for (const l of [...(this.v.get(vaultId)?.listeners.get(chatId) ?? [])]) l(e);
  }

  vaultRemoved(vaultId: string) {
    const c = this.v.get(vaultId);
    if (!c) return;
    c.unsubscribe();
    clearInterval(c.poll);
    this.v.delete(vaultId);
  }
}

export const aiUnavailable = () => new HttpError(503, 'The AI service is not reachable right now. Try again in a moment.', 'ai-unavailable');

const unsafeMessage = (found: string) =>
  `Chat is disabled for this vault: it contains "${found}", opencode project config that would run code on the server. Remove it from the repo to use chat.`;
