import { posix } from 'node:path';
import type { ChatMessage, ChatPart, ToolCall, ToolStatus } from '@karpathy/shared';

/**
 * Maps opencode's wire shapes to the backend↔harness vocabulary (ACP-shaped: session /
 * prompt / update / tool_call / permission). Nothing outside `harness/` sees opencode types,
 * so the harness stays swappable.
 */
export type HarnessEvent =
  | { type: 'status'; sessionId: string; state: 'busy' | 'idle' | 'retry'; message?: string }
  | { type: 'message'; sessionId: string; message: Omit<ChatMessage, 'parts'> }
  | { type: 'part'; sessionId: string; messageId: string; part: ChatPart }
  | { type: 'text-delta'; sessionId: string; messageId: string; partId: string; delta: string }
  | { type: 'error'; sessionId: string; message: string; aborted: boolean }
  | { type: 'file-edited'; path: string };

const DENIED_PREFIX = 'The user has specified a rule which prevents you from using this specific tool call';
/**
 * File-writing tools; save_url (deploy/opencode/tools) downloads a media file or PDF into the vault,
 * move_to_sources moves an input item to Sources/ and lists the moved files in its metadata.
 */
const WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit', 'save_url', 'move_to_sources']);
/** Tools that ask the UI to show a note (deploy/opencode/tools). */
const OPEN_TOOLS = new Set(['open_note']);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * A tool path as opencode sees it (absolute, or relative to the session dir, e.g. `./x.md`)
 * → vault-relative; kept absolute if it lies outside the root.
 */
export function toVaultPath(p: string, root: string): string {
  const abs = posix.resolve(root, p);
  const rel = posix.relative(root, abs);
  if (rel === '') return ''; // the vault root itself
  return rel.startsWith('..') ? abs : rel;
}

export function mapToolPart(part: Json, root: string): ToolCall {
  const state = obj(part.state);
  const input = obj(state.input);
  const meta = obj(state.metadata);
  const tool = str(part.tool) ?? 'tool';
  let status = (str(state.status) ?? 'pending') as ToolStatus;
  const error = str(state.error);
  if (status === 'error' && error?.startsWith(DENIED_PREFIX)) status = 'denied';
  const patchFile = Array.isArray(meta.files) ? str(obj(meta.files[0]).filePath) : undefined;
  const moved = tool === 'move_to_sources' && str(input.name) ? `Sources/${str(input.name)}` : undefined;
  const rawPath = str(input.filePath) ?? moved ?? patchFile ?? str(input.path);
  const path = rawPath ? toVaultPath(rawPath, root) : '';
  return {
    id: str(part.id) ?? str(part.callID) ?? '',
    tool,
    status,
    writes: WRITE_TOOLS.has(tool),
    opens: OPEN_TOOLS.has(tool),
    ...(path ? { path } : {}),
    ...(tool === 'websearch' && str(input.query) ? { query: str(input.query) } : {}),
    ...((tool === 'webfetch' || tool === 'open_url' || tool === 'save_url') && str(input.url) ? { url: str(input.url) } : {}),
    ...(str(state.title) ? { title: str(state.title) } : {}),
    ...(error && status === 'error' ? { error } : {}),
  };
}

/** Paths a completed write tool changed (cross-check for the AI-touched set). */
export function writtenPaths(part: Json, root: string): string[] {
  const state = obj(part.state);
  if (!WRITE_TOOLS.has(str(part.tool) ?? '') || state.status !== 'completed') return [];
  const meta = obj(state.metadata);
  const out: string[] = [];
  const fp = str(obj(state.input).filePath);
  if (fp) out.push(fp);
  if (Array.isArray(meta.files))
    for (const f of meta.files) {
      const o = obj(f);
      for (const k of ['filePath', 'movePath']) if (str(o[k])) out.push(str(o[k])!);
    }
  return out.map((p) => toVaultPath(p, root));
}

export function mapPart(part: Json, root: string): ChatPart | null {
  const id = str(part.id) ?? '';
  switch (part.type) {
    case 'text':
      if (part.synthetic) return null;
      return { type: 'text', id, text: str(part.text) ?? '' };
    case 'reasoning':
      return { type: 'reasoning', id, text: str(part.text) ?? '' };
    case 'tool':
      return { type: 'tool', id, call: mapToolPart(part, root) };
    case 'file':
      // `url` is a data: URL by now (the bytes): only the vault path we sent as the file name goes on.
      return str(part.filename) ? { type: 'file', id, path: str(part.filename)!, mime: str(part.mime) ?? '' } : null;
    default:
      return null;
  }
}

function errorMessage(e: unknown): string | undefined {
  const o = obj(e);
  if (!o.name && !o.data) return undefined;
  return str(obj(o.data).message) ?? str(o.name) ?? 'error';
}

export function mapMessageInfo(info: Json): Omit<ChatMessage, 'parts'> {
  const err = errorMessage(info.error);
  // Assistant messages carry providerID/modelID, user messages a model object.
  const m = info.providerID ? info : obj(info.model);
  const model = str(m.providerID) && str(m.modelID) ? `${str(m.providerID)}/${str(m.modelID)}` : undefined;
  return {
    id: str(info.id) ?? '',
    role: info.role === 'user' ? 'user' : 'assistant',
    createdAt: Number(obj(info.time).created ?? 0),
    ...(model ? { model } : {}),
    ...(err ? { error: err } : {}),
  };
}

export function mapMessages(list: unknown[], root: string): ChatMessage[] {
  return list.map((m) => {
    const o = obj(m);
    const parts = (Array.isArray(o.parts) ? o.parts : []).map((p) => mapPart(obj(p), root)).filter((p): p is ChatPart => p !== null);
    return { ...mapMessageInfo(obj(o.info)), parts };
  });
}

/** One opencode bus event → zero or one harness event. `root` = the vault root as opencode sees it. */
export function mapEvent(raw: unknown, root: string): HarnessEvent | null {
  const e = obj(raw);
  const p = obj(e.properties);
  const sessionId = str(p.sessionID) ?? '';
  switch (e.type) {
    case 'session.status': {
      const st = obj(p.status);
      const type = str(st.type);
      if (type !== 'busy' && type !== 'idle' && type !== 'retry') return null;
      return { type: 'status', sessionId, state: type, ...(str(st.message) ? { message: str(st.message) } : {}) };
    }
    case 'message.updated':
      return { type: 'message', sessionId, message: mapMessageInfo(obj(p.info)) };
    case 'message.part.updated': {
      const part = obj(p.part);
      const mapped = mapPart(part, root);
      if (!mapped) return null;
      return { type: 'part', sessionId: sessionId || (str(part.sessionID) ?? ''), messageId: str(part.messageID) ?? '', part: mapped };
    }
    case 'message.part.delta':
      if (p.field !== 'text') return null;
      return { type: 'text-delta', sessionId, messageId: str(p.messageID) ?? '', partId: str(p.partID) ?? '', delta: str(p.delta) ?? '' };
    case 'session.error': {
      const err = obj(p.error);
      return { type: 'error', sessionId, message: errorMessage(err) ?? 'error', aborted: err.name === 'MessageAbortedError' };
    }
    case 'file.edited':
      return str(p.file) ? { type: 'file-edited', path: toVaultPath(str(p.file)!, root) } : null;
    default:
      return null;
  }
}
