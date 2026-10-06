import type { ChatDetail, ChatEvent, ChatMessage, ChatPart, ToolCall } from '@karpathy/shared';

export interface ChatView extends ChatDetail {
  readonly?: boolean;
  /** What a queued turn waits for. */
  waiting?: 'turn' | 'sync';
  error?: string;
}

/** Applies one stream event to the chat (pure). */
export function applyChatEvent(c: ChatView, e: ChatEvent): ChatView {
  switch (e.type) {
    case 'turn':
      return { ...c, turn: e.state, readonly: e.readonly ?? c.readonly, waiting: e.waiting };
    case 'error':
      return { ...c, error: e.message };
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
  return e.type === 'turn' && e.state === 'idle' ? (turnEnded(o) ?? now) : now;
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
 * step, so consecutive assistant messages merge into one turn with one header.
 */
export function turns(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
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

export const userCount = (c: ChatView | null) => c?.messages.filter((m) => m.role === 'user').length ?? 0;

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

/**
 * A prompt queued on the server (after a reload, or sent from another device) becomes the pending
 * bubble when this client has none, so it is visible and a Stop restores it (pure).
 */
export function adoptQueued(p: PendingPrompt | null, c: ChatView): PendingPrompt | null {
  if (p || c.turn !== 'queued' || !c.queuedText) return p;
  return { text: c.queuedText, userCount: userCount(c), sent: true, ran: false };
}

/**
 * What the chat's live region says when the turn state changes (issue #45, pure): the start, the
 * finished reply (its text, capped) or its error, a queue wait — never the streamed deltas.
 */
export function turnAnnouncement(prev: ChatView['turn'] | undefined, c: ChatView): string | null {
  if (!prev || prev === c.turn) return null;
  if (c.turn === 'running') return 'AI is replying…';
  if (c.turn === 'queued') return c.waiting === 'sync' ? 'Waiting for sync…' : 'Waiting for other chat…';
  // Only this turn's reply: the last message, if the assistant wrote it.
  const last = c.messages.at(-1)?.role === 'assistant' ? c.messages.at(-1) : undefined;
  const error = c.error ?? last?.error;
  if (error) return `Reply failed: ${error}`;
  const text = (last?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  return text ? `Reply finished: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}` : 'Reply finished';
}

/** The label of a tool chip. */
export function toolLabel(call: ToolCall): string {
  if (call.status === 'denied' || call.status === 'error')
    return `${call.status === 'denied' ? 'denied · ' : ''}${call.tool} ${call.path ?? call.url ?? call.title ?? ''}`;
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
