import type {
  ChatDetail, ChatSummary, Change, Command, InstagramStatus, CommitResult, ConflictChoice, Diff, FileContent, FileEntry, GraphData,
  SearchHit, Settings, SettingsView, TokenTest, UploadResult, Vault, VaultConfig, VaultStatus,
} from '@karpathy/shared';

import { parseLoginCode } from './login-code';

const TOKEN_KEY = 'karpathy.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);

/**
 * Login link `#token=…` (`just token <target> --qr`): stores the token and removes it from the URL
 * and the history before anything routes on the hash. The fragment never reaches the server.
 */
export function takeTokenFromUrl() {
  if (!location.hash.startsWith('#token=')) return;
  const token = parseLoginCode(location.hash);
  if (!token) return;
  setToken(token);
  history.replaceState(null, '', location.pathname + location.search);
}

let onUnauthorized = () => {};
/** Called on any 401: the stored token is dropped and the app shows the token screen. */
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Raw authed fetch against /api; throws ApiError for non-2xx. */
export async function request(method: string, path: string, body?: unknown, signal?: AbortSignal, keepalive = false): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` };
  // A Blob is a file's bytes (upload); everything else is JSON.
  const bytes = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = bytes ? 'application/octet-stream' : 'application/json';
  const data = body === undefined ? undefined : bytes ? body : JSON.stringify(body);
  // keepalive lets a save outlive the page (pagehide), but browsers cap such bodies at 64 KiB.
  const res = await fetch(`/api${path}`, { method, headers, body: data, signal, keepalive: keepalive && new Blob([data ?? '']).size < 60_000 });
  if (res.ok) return res;
  const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    // The offline cache holds note contents; drop it together with the token.
    void globalThis.caches?.delete('vault-api');
    onUnauthorized();
  }
  throw new ApiError(res.status, typeof err.error === 'string' ? err.error : `${res.status} ${res.statusText}`, err.code as string | undefined, err);
}

async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, keepalive = false): Promise<T> {
  const res = await request(method, path, body, signal, keepalive);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const v = (id: string) => `/vaults/${encodeURIComponent(id)}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;

export const api = {
  health: () => json<{ backend: string; opencode: string; version: string; built: string | null; deployed: string | null }>('GET', '/health'),
  settings: () => json<SettingsView>('GET', '/settings'),
  patchSettings: (s: Partial<Settings>) => json<SettingsView>('PATCH', '/settings', s),
  putGithubToken: (token: string) => json<void>('PUT', '/settings/github-token', { token }),
  removeGithubToken: () => json<void>('DELETE', '/settings/github-token'),
  /** Tests `token`, or the stored token when omitted. */
  testGithubToken: (token?: string) => json<TokenTest>('POST', '/settings/github-token/test', token ? { token } : {}),

  instagram: () => json<InstagramStatus>('GET', '/ingest/instagram'),
  instagramLogin: (username: string, password: string) => json<InstagramStatus>('POST', '/ingest/instagram/login', { username, password }),
  instagramCode: (code: string) => json<InstagramStatus>('POST', '/ingest/instagram/code', { code }),
  instagramDisconnect: () => json<InstagramStatus>('POST', '/ingest/instagram/disconnect'),

  vaults: () => json<Vault[]>('GET', '/vaults'),
  addVault: (c: Omit<VaultConfig, 'id'> & { createFolders?: boolean }) => json<Vault>('POST', '/vaults', c),
  patchVault: (id: string, c: Partial<Omit<VaultConfig, 'id'>>) => json<Vault>('PATCH', v(id), c),
  removeVault: (id: string) => json<void>('DELETE', v(id)),

  open: (id: string) => json<VaultStatus>('POST', `${v(id)}/open`),
  status: (id: string) => json<VaultStatus>('GET', `${v(id)}/status`),
  events: (id: string, signal: AbortSignal) => request('GET', `${v(id)}/events`, undefined, signal),

  /** The bytes of a vault file (`GET /raw`): media as stored, anything else as an attachment. */
  raw: (id: string, path: string, signal?: AbortSignal) => request('GET', `${v(id)}/raw?${q(path)}`, undefined, signal),
  rawHead: (id: string, path: string) => request('HEAD', `${v(id)}/raw?${q(path)}`),
  files: (id: string) => json<FileEntry[]>('GET', `${v(id)}/files`),
  file: (id: string, path: string) => json<FileContent>('GET', `${v(id)}/file?${q(path)}`),
  putFile: (id: string, path: string, content: string, version: string | null, force = false, keepalive = false) =>
    json<{ version: string }>('PUT', `${v(id)}/file?${q(path)}`, { content, version, ...(force ? { force } : {}) }, undefined, keepalive),
  deleteFile: (id: string, path: string, version: string) =>
    json<void>('DELETE', `${v(id)}/file?${q(path)}&version=${encodeURIComponent(version)}`),
  /**
   * Stores a file from the device: next to the note `note` (its own folder), or in a chat's source folder
   * (`source: 'new'` with the local time `at`, or the folder name of an earlier upload). The server picks the final name.
   */
  upload: (id: string, name: string, target: { note: string } | { source: string; at?: string }, bytes: Blob) =>
    json<UploadResult>('POST', `${v(id)}/raw?name=${encodeURIComponent(name)}&${new URLSearchParams(target as Record<string, string>)}`, bytes),
  search: (id: string, text: string, signal?: AbortSignal) =>
    json<{ hits: SearchHit[]; truncated: boolean }>('GET', `${v(id)}/search?q=${encodeURIComponent(text)}`, undefined, signal),
  graph: (id: string) => json<GraphData>('GET', `${v(id)}/graph`),

  changes: (id: string) => json<Change[]>('GET', `${v(id)}/changes`),
  diff: (id: string, path: string) => json<Diff>('GET', `${v(id)}/changes/diff?${q(path)}`),
  /** `version` = what the user reviewed; the backend refuses if the file changed since (#32). */
  discard: (id: string, path: string, version?: string | null) =>
    json<void>('POST', `${v(id)}/discard?${q(path)}${version !== undefined ? `&version=${encodeURIComponent(String(version))}` : ''}`),
  commitMessage: (id: string, signal: AbortSignal) => json<{ message: string }>('POST', `${v(id)}/commit-message`, undefined, signal),
  /** `paths` = the changed files the user reviewed; 409 `changes-moved` if others arrived (#33). */
  commit: (id: string, message: string, paths?: string[]) => json<CommitResult>('POST', `${v(id)}/commit`, { message, paths }),
  push: (id: string) => json<CommitResult>('POST', `${v(id)}/push`),
  pull: (id: string) => json<VaultStatus>('POST', `${v(id)}/pull`),
  conflictSides: (id: string, path: string) => json<{ mine: string | null; theirs: string | null }>('GET', `${v(id)}/conflicts/sides?${q(path)}`),
  resolve: (id: string, path: string, choice: ConflictChoice) => json<VaultStatus>('POST', `${v(id)}/conflicts/resolve`, { path, choice }),

  commands: (id: string) => json<Command[]>('GET', `${v(id)}/commands`),
  chats: (id: string) => json<ChatSummary[]>('GET', `${v(id)}/chats`),
  newChat: (id: string) => json<{ chatId: string }>('POST', `${v(id)}/chats`),
  chat: (id: string, chatId: string) => json<ChatDetail>('GET', `${v(id)}/chats/${encodeURIComponent(chatId)}`),
  deleteChat: (id: string, chatId: string) => json<void>('DELETE', `${v(id)}/chats/${encodeURIComponent(chatId)}`),
  prompt: (id: string, chatId: string, text: string, attachments?: string[]) =>
    json<{ queued: boolean }>('POST', `${v(id)}/chats/${encodeURIComponent(chatId)}/prompt`, { text, ...(attachments?.length ? { attachments } : {}) }),
  chatStream: (id: string, chatId: string, signal: AbortSignal) => request('GET', `${v(id)}/chats/${encodeURIComponent(chatId)}/stream`, undefined, signal),
  abort: (id: string, chatId: string) => json<void>('POST', `${v(id)}/chats/${encodeURIComponent(chatId)}/abort`),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
