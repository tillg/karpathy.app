import { isPdf } from '@karpathy/shared';
import type { ChatDetail, ChatEvent, ChatMessage, ChatPart, ContextUsage, ModelInput, QueuedPrompt, ReturnedPrompt, ToolCall } from '@karpathy/shared';
import type { ChipDraft } from './chips';

export interface ChatView extends ChatDetail {
  readonly?: boolean;
  /** What a queued turn waits for. */
  waiting?: 'turn' | 'sync';
  error?: string;
  /** The queued prompt that last left the queue to run (#155): shown as the pending bubble until its message arrives. */
  started?: QueuedPrompt;
}

/** Applies one stream event to the chat (pure). */
export function applyChatEvent(c: ChatView, e: ChatEvent): ChatView {
  switch (e.type) {
    case 'turn':
      return { ...c, turn: e.state, readonly: e.readonly ?? c.readonly, waiting: e.waiting };
    case 'error':
      return { ...c, error: e.message };
    case 'queue': {
      const started = e.started ? c.queued.find((q) => q.id === e.started) : undefined;
      return { ...c, queued: e.queued, ...(started ? { started } : {}) };
    }
    case 'message': {
      const i = c.messages.findIndex((m) => m.id === e.message.id);
      if (i < 0) return { ...c, messages: [...c.messages, { ...e.message, parts: [] }] };
      const messages = [...c.messages];
      messages[i] = { ...messages[i]!, ...e.message };
      return { ...c, messages };
    }
    case 'part':
      return mapMessage(c, e.messageId, (parts) => {
        const i = parts.findIndex((p) => p.id === e.part.id);
        if (i < 0) return [...parts, e.part];
        const next = [...parts];
        next[i] = e.part;
        return next;
      });
    case 'text-delta':
      return mapMessage(c, e.messageId, (parts) => {
        const i = parts.findIndex((p) => p.id === e.partId);
        if (i < 0) return [...parts, { type: 'text', id: e.partId, text: e.delta }];
        const p = parts[i]!;
        if (p.type === 'tool' || p.type === 'file') return parts;
        const next = [...parts];
        next[i] = { ...p, text: p.text + e.delta };
        return next;
      });
  }
}

function mapMessage(c: ChatView, id: string, fn: (parts: ChatPart[]) => ChatPart[]): ChatView {
  let found = false;
  const messages = c.messages.map((m) => {
    if (m.id !== id) return m;
    found = true;
    return { ...m, parts: fn(m.parts) };
  });
  // A part can arrive before its message meta; create a placeholder assistant message.
  if (!found) messages.push({ id, role: 'assistant', createdAt: Date.now(), parts: fn([]) });
  return { ...c, messages };
}

/** Files a message's completed write tools changed, in order, deduplicated. */
export function changedPaths(parts: ChatPart[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === 'tool' && p.call.writes && p.call.status === 'completed' && p.call.path && !out.includes(p.call.path)) out.push(p.call.path);
  }
  return out;
}

/**
 * The AI's open requests of one chat view: calls already acted on or in the first-loaded history
 * (`seen`), and, where the open waits for the turn's end (`defer`: layouts that aren't wide), the
 * turn's latest request.
 */
export interface Opens { seen: Set<string>; later: string | null; loaded: boolean }
export const newOpens = (): Opens => ({ seen: new Set(), later: null, loaded: false });

/** A wanted open: shown now, or kept until the turn ends. Returns the note to show now. */
function want(o: Opens, path: string | null, defer: boolean): string | null {
  if (path && defer) o.later = path;
  return defer ? null : path;
}

function turnEnded(o: Opens): string | null {
  const p = o.later;
  o.later = null;
  return p;
}

/**
 * A (re)loaded chat. The first load only marks its completed opens seen: history never opens a
 * note. A reload after a dropped stream treats opens completed in the gap as live. Returns the note
 * to show now.
 */
export function opensFromLoad(o: Opens, messages: ChatMessage[], turn: ChatView['turn'], defer: boolean): string | null {
  let path: string | null = null;
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type !== 'tool' || !p.call.opens || p.call.status !== 'completed') continue;
      if (o.loaded) path = noteToOpen({ type: 'part', messageId: m.id, part: p }, o.seen) ?? path;
      else o.seen.add(p.id);
    }
  o.loaded = true;
  const now = want(o, path, defer);
  return turn === 'idle' ? (turnEnded(o) ?? now) : now;
}

/** A live stream event. Returns the note to show now. */
export function opensFromEvent(o: Opens, e: ChatEvent, defer: boolean): string | null {
  const now = want(o, noteToOpen(e, o.seen), defer);
  // A turn ends in idle, or in queued when more of the chat's prompts wait (#155).
  return e.type === 'turn' && e.state !== 'running' ? (turnEnded(o) ?? now) : now;
}

/**
 * The note a live stream event asks the UI to show: a completed open call not in `seen` (which it
 * joins), so a replayed call opens nothing twice (pure apart from `seen`).
 */
export function noteToOpen(e: ChatEvent, seen: Set<string>): string | null {
  if (e.type !== 'part' || e.part.type !== 'tool') return null;
  const { call } = e.part;
  if (!call.opens || call.status !== 'completed' || !call.path || seen.has(e.part.id)) return null;
  seen.add(e.part.id);
  return call.path;
}

export type Turn =
  | { role: 'user'; id: string; message: ChatMessage }
  | { role: 'assistant'; id: string; model?: string; parts: ChatPart[]; errors: string[] };

/**
 * The chat as the user reads it (#63, pure): the harness makes one assistant message per tool
 * step, so consecutive assistant messages merge into one turn with one header. A suggest_next call
 * has no chip: the composer shows it as ghost text (#145).
 */
export function turns(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const raw of messages) {
    const m = { ...raw, parts: raw.parts.filter((p) => !(p.type === 'tool' && p.call.tool === 'suggest_next')) };
    const last = out.at(-1);
    if (m.role === 'user') out.push({ role: 'user', id: m.id, message: m });
    else if (last?.role === 'assistant') {
      last.parts = [...last.parts, ...m.parts];
      last.model ??= m.model;
      if (m.error) last.errors.push(m.error);
    } else out.push({ role: 'assistant', id: m.id, model: m.model, parts: m.parts, errors: m.error ? [m.error] : [] });
  }
  return out;
}

/** An optimistic prompt shown as a user bubble until the server has the message. */
export interface PendingPrompt {
  /** The queued prompt it was (#155). */
  id?: string;
  text: string;
  /** Vault paths of the files sent with it, shown in the bubble too. */
  attachments?: string[];
  /** User messages in the chat when the prompt was sent. */
  userCount: number;
  /** The server accepted (queued) the prompt. */
  sent: boolean;
  /** The turn was seen running. */
  ran: boolean;
}

/** User messages with something to show: one whose parts haven't arrived yet (the hidden local-time part comes first) doesn't count. */
export const userCount = (c: ChatView | null) => c?.messages.filter((m) => m.role === 'user' && m.parts.length > 0).length ?? 0;

/**
 * Next state of a pending prompt given the latest chat (pure): keep it (possibly updated),
 * `drop` it (the server has the message), or `restore` it to the composer — the turn went idle
 * without ever running (stopped while queued, or the pull before it failed).
 */
export function settlePending(p: PendingPrompt, c: ChatView): PendingPrompt | 'drop' | 'restore' {
  if (userCount(c) > p.userCount) return 'drop';
  if (!p.sent) return p;
  if (c.turn === 'running') return p.ran ? p : { ...p, ran: true };
  if (c.turn === 'idle') return p.ran ? 'drop' : 'restore';
  return p;
}

/** A pending bubble whose POST has not answered yet (local id) that is the queued prompt `q`: same text and files. */
const unsentIs = (p: PendingPrompt, q: QueuedPrompt) =>
  !p.sent && p.text === q.text && (p.attachments ?? []).join('\n') === (q.attachments ?? []).join('\n');

/**
 * A queued prompt that just started (#155) becomes the pending bubble (pure). A pending bubble that never ran (its turn
 * failed before it reached the AI) is handed back as `restore`, for the composer. Null: nothing changes. A pending
 * bubble still waiting for its POST's answer that matches the started prompt is that prompt: it takes its id.
 */
export function adoptStarted(p: PendingPrompt | null, c: ChatView): { pending: PendingPrompt; restore: PendingPrompt | null } | null {
  const s = c.started;
  if (!s || p?.id === s.id) return null;
  if (p && unsentIs(p, s)) return { pending: { ...p, id: s.id, sent: true }, restore: null };
  const pending: PendingPrompt = { id: s.id, text: s.text, ...(s.attachments?.length ? { attachments: s.attachments } : {}), userCount: userCount(c), sent: true, ran: false };
  return { pending, restore: p && !p.ran && userCount(c) <= p.userCount ? p : null };
}

/**
 * The queued bubbles to show (pure): all but the pending bubble's prompt. Before its POST answers, the pending bubble
 * has a local id, while a reload may already list the prompt under the server's id: the first match is left out.
 */
export function visibleQueued(queued: QueuedPrompt[], p: PendingPrompt | null): QueuedPrompt[] {
  if (!p) return queued;
  const i = p.sent ? -1 : queued.findIndex((q) => unsentIs(p, q));
  return queued.filter((q, j) => q.id !== p.id && j !== i);
}

/**
 * The composer after queued prompts were taken back (#155, pure): their texts, oldest first, before what is typed,
 * their files in front of the chips. The draft keeps its upload folder, or takes the first returned file's.
 */
export function withReturned(text: string, draft: ChipDraft, back: ReturnedPrompt[]): { text: string; draft: ChipDraft } {
  if (!back.length) return { text, draft };
  const chips = back.flatMap((b) => b.attachments);
  return {
    text: [...back.map((b) => b.text), text].filter((t) => t.trim()).join('\n\n'),
    draft: { chips: [...chips, ...draft.chips], folder: draft.folder ?? chips[0]?.path.split('/')[1] ?? null },
  };
}

/**
 * What the chat's live region says when the turn state changes (issue #45, pure): the start, the
 * finished reply (its text, capped) or its error, a queue wait — never the streamed deltas.
 */
export function turnAnnouncement(prev: ChatView['turn'] | undefined, c: ChatView): string | null {
  if (!prev || prev === c.turn) return null;
  if (c.turn === 'running') return 'AI is replying…';
  // A turn that ends with more of the chat's prompts waiting ends in queued (#155): it finished all the same.
  if (c.turn === 'queued' && prev !== 'running') return c.waiting === 'sync' ? 'Waiting for sync…' : 'Waiting for other chat…';
  // Only this turn's reply: the whole last assistant turn (its last message may hold just the hidden suggest_next call).
  const last = turns(c.messages).at(-1);
  const reply = last?.role === 'assistant' ? last : undefined;
  const error = c.error ?? reply?.errors[0];
  if (error) return `Reply failed: ${error}`;
  const text = (reply?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  return text ? `Reply finished: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}` : 'Reply finished';
}

/** The label of a tool chip. */
export function toolLabel(call: ToolCall): string {
  if (call.status === 'denied' || call.status === 'error')
    return `${call.status === 'denied' ? 'denied · ' : ''}${call.tool} ${call.path ?? call.url ?? call.title ?? ''}`;
  // Browser tools (#151): waiting for the tab that sent the prompt, then the title the tool set.
  if (call.browser && call.status === 'running') return call.tool === 'user_location' ? 'open the app to share your location' : `waiting for ${call.tool}`;
  if (call.browser && call.title) return call.title;
  if (call.tool === 'websearch' && call.query) return `searched the web: "${call.query}"`;
  if ((call.tool === 'webfetch' || call.tool === 'open_url') && call.url) {
    const verb = call.tool === 'webfetch' ? 'fetched' : 'open';
    try {
      const u = new URL(call.url);
      return `${verb} ${u.host}${(u.pathname + u.search).slice(0, 60)}`;
    } catch {
      return `${verb} ${call.url}`;
    }
  }
  return `${call.writes ? 'changing' : call.tool} ${call.path ?? call.title ?? ''}`;
}

/** Where a fetch or Open chip links to: the URL of a completed http(s) fetch or link offer, else null. */
export function toolHref(call: ToolCall): string | null {
  if ((call.tool !== 'webfetch' && call.tool !== 'open_url') || call.status !== 'completed' || !call.url) return null;
  return /^https?:\/\//i.test(call.url) ? call.url : null;
}

/**
 * The ghost text of the composer (#145, pure): the suggestion of the latest completed suggest_next call in
 * the replies after the last prompt, while no turn runs. Derived from history, so a reload shows it again.
 */
export function nextSuggestion(messages: ChatMessage[], turn: ChatView['turn']): string | null {
  if (turn !== 'idle') return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return null;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!;
      if (p.type === 'tool' && p.call.tool === 'suggest_next' && p.call.status === 'completed' && p.call.suggestion) return p.call.suggestion;
    }
  }
  return null;
}

/** Tab, plain: accepts the suggestion (Shift+Tab and shortcuts keep their meaning). */
export const isAcceptKey = (e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;

/** The composer's context meter (#140): the newest AI reply that has tokens, and the model it ran with. */
export function lastContext(messages: ChatMessage[]): { usage: ContextUsage; model?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.context) return { usage: m.context, ...(m.model ? { model: m.model } : {}) };
  }
  return null;
}

/**
 * What an unsent attachment's chip warns about: a PDF the model can't read. Images never warn (#146): a text-only
 * model gets them described by the look_at_image tool. Null = no warning.
 */
export function attachWarning(input: ModelInput | null | undefined, path: string, model: string): string | null {
  if (!input || !isPdf(path) || input.pdf) return null;
  return `${model} can’t see PDFs: the AI only gets the file’s path`;
}

/** Short numbers (`950`, `29K`, `1.5M`), in the given locale; the context meter and the admin charts share it. */
export function shortNumber(x: number, locale?: string): string {
  const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return x < 1000 ? fmt.format(x) : Math.round(x / 1000) < 1000 ? `${Math.round(x / 1000)}K` : `${fmt.format(x / 1e6)}M`;
}
