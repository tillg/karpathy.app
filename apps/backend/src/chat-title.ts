import type { ChatMessage, VaultEvent } from '@karpathy/shared';
import type { ConfigStore } from './config-store.js';
import type { Harness } from './harness/opencode.js';
import type { Vaults } from './vaults.js';

const TIMEOUT_MS = 30_000;
/** The conversation the title model reads, at most: fits a 16K-token dev model with room to answer. */
const MAX_TRANSCRIPT = 12_000;
const MAX_MESSAGE = 1500;
const MAX_TITLE = 120;
/** The turn after which the preliminary title is replaced; then every DRIFT_EVERY turns a drift check. */
const TITLE_TURN = 2;
const DRIFT_EVERY = 10;

/** The conversation as `User:` / `AI:` blocks of text parts, each cut, oldest dropped first to stay within `max`. */
export function transcript(messages: ChatMessage[], max = MAX_TRANSCRIPT): string {
  const blocks = messages
    .map((m) => {
      const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return `${m.role === 'user' ? 'User' : 'AI'}: ${text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text}`;
    })
    .filter(Boolean);
  const out: string[] = [];
  let size = 0;
  for (const b of blocks.reverse()) {
    if (size + b.length + 2 > max) break;
    out.unshift(b);
    size += b.length + 2;
  }
  return out.join('\n\n');
}

/** The model's answer as a title: its first line without quotes, Markdown, a `Title:` prefix or a trailing period. */
export function cleanTitle(answer: string): string {
  const line = answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const t = line
    .replace(/^#+\s*/, '')
    .replace(/^(\*\*)?title(\*\*)?\s*:\s*/i, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^["'“”„«»]+|["'“”„«»]+$/g, '')
    .replace(/\.+$/, '')
    .trim();
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE).trim() : t;
}

/**
 * AI-written chat titles (#148): after turn 2 the title model replaces the preliminary title (the first prompt); after
 * turn 10, 20, … it checks for drift and a new title becomes a suggestion the user accepts or dismisses. Runs like
 * the commit-message proposal: a throwaway opencode session with the tool-less `chat-title` agent, deleted afterwards,
 * but outside the vault's directory: its chat list would show it meanwhile (and a skill refresh there can't cut it off).
 * Never throws: a failing or slow model keeps the title.
 */
export class ChatTitles {
  constructor(
    private readonly vaults: Pick<Vaults, 'harnessConfigIn'>,
    private readonly store: ConfigStore,
    private readonly harness: Harness,
    private readonly dirOf: (vaultId: string) => string,
    /** Where the throwaway sessions run: the vaults dir itself, so no vault's chat list (sessions of its own dir) shows them. */
    private readonly taskDir: string,
    private readonly emit: (vaultId: string, e: VaultEvent) => void,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  suggestion(vaultId: string, chatId: string): string | undefined {
    return this.store.get().titleSuggestions[vaultId]?.[chatId];
  }

  /** Called when a turn ended. */
  async afterTurn(vaultId: string, chatId: string): Promise<void> {
    try {
      if (this.vaults.harnessConfigIn(vaultId)) return;
      const dir = this.dirOf(vaultId);
      const messages = await this.harness.messages(dir, chatId);
      const turns = messages.filter((m) => m.role === 'user').length;
      const drift = turns >= DRIFT_EVERY && turns % DRIFT_EVERY === 0;
      if (turns !== TITLE_TURN && !drift) return;
      const current = (await this.harness.listSessions(dir)).find((s) => s.id === chatId)?.title ?? '';
      const text = drift
        ? `${transcript(messages)}\n\nCurrent title: ${current}\n\nDoes the current title still describe this conversation? If it does, reply exactly KEEP. If not, reply with a better title.`
        : `${transcript(messages)}\n\nWrite the title of this conversation.`;
      const title = cleanTitle(await this.ask(text));
      if (!title || title.toUpperCase() === 'KEEP' || title === current) return;
      if (drift) {
        await this.setSuggestion(vaultId, chatId, title);
        this.emit(vaultId, { type: 'chat-title', chatId, title: current, titleSuggestion: title });
      } else {
        await this.harness.setTitle(dir, chatId, title);
        this.emit(vaultId, { type: 'chat-title', chatId, title });
      }
    } catch (e) {
      console.warn(`chat title ${vaultId}/${chatId}:`, (e as Error).message);
    }
  }

  /** The user's own title (accepting a suggestion): set it and drop the suggestion. */
  async rename(vaultId: string, chatId: string, title: string): Promise<void> {
    const t = title.trim();
    await this.harness.setTitle(this.dirOf(vaultId), chatId, t);
    await this.setSuggestion(vaultId, chatId, undefined);
    this.emit(vaultId, { type: 'chat-title', chatId, title: t });
  }

  /** Keep the title: drop the suggestion. */
  async dismiss(vaultId: string, chatId: string): Promise<void> {
    await this.setSuggestion(vaultId, chatId, undefined);
    const title = (await this.harness.listSessions(this.dirOf(vaultId)).catch(() => [])).find((s) => s.id === chatId)?.title ?? '';
    this.emit(vaultId, { type: 'chat-title', chatId, title });
  }

  /** A chat (or, without `chatId`, every chat of the vault) was deleted. */
  async forget(vaultId: string, chatId?: string): Promise<void> {
    if (!this.store.get().titleSuggestions[vaultId]) return;
    if (chatId === undefined) return this.store.update((c) => { delete c.titleSuggestions[vaultId]; });
    await this.setSuggestion(vaultId, chatId, undefined);
  }

  private setSuggestion(vaultId: string, chatId: string, title: string | undefined): Promise<void> {
    return this.store.update((c) => {
      const chats = { ...c.titleSuggestions[vaultId] };
      if (title === undefined) delete chats[chatId];
      else chats[chatId] = title;
      if (Object.keys(chats).length) c.titleSuggestions[vaultId] = chats;
      else delete c.titleSuggestions[vaultId];
    });
  }

  /** One prompt in a throwaway session of the task dir. */
  private async ask(text: string): Promise<string> {
    const dir = this.taskDir;
    const settings = this.store.get().settings;
    let sessionId: string | undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const work = (async () => {
        sessionId = await this.harness.createSession(dir, 'chat title');
        return this.harness.promptSync(dir, sessionId, { text, agent: 'chat-title', model: settings.titleModel || settings.model }, ctrl.signal);
      })();
      const aborted = new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('timeout'))));
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      if (sessionId) {
        const id = sessionId;
        await this.harness.abort(dir, id).catch(() => undefined);
        await this.harness.deleteSession(dir, id).catch(() => undefined);
      }
    }
  }
}
