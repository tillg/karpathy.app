// API types shared by backend and web. All routes sit under /api (mvp §3.2).

export type VaultState = 'cloning' | 'ready' | 'clone-failed' | 'conflict';

export interface VaultConfig {
  id: string;
  name: string;
  /** GitHub repo as `owner/name`. */
  repo: string;
  branch: string;
  /** Subfolder of the repo the vault starts at; '' = repo root. */
  root: string;
}

export interface Vault extends VaultConfig {
  state: VaultState;
  /** Git error when state is `clone-failed`. */
  error?: string;
}

export interface Settings {
  commitReminderThreshold: number;
  /** `provider/model`, e.g. `anthropic/claude-sonnet-5`. */
  model: string;
  /** The AI may search the web and read pages (opencode websearch/webfetch), in every vault. */
  webAccess: boolean;
}

/** What a model reads besides text (opencode's `capabilities.input`). */
export interface ModelInput {
  image: boolean;
  pdf: boolean;
}

/** `GET /settings`: the settings plus the GitHub token's state — never the token itself. */
export interface SettingsView extends Settings {
  githubToken: { source: 'settings' | 'secret' | 'none'; last4: string | null };
  /** What the current model reads; null when opencode is down or doesn't list the model. */
  modelInput: ModelInput | null;
}

/** `POST /settings/github-token/test`. */
export interface TokenTest {
  /** GitHub accepted the token (`GET /user`). */
  ok: boolean;
  login?: string;
  /** `X-OAuth-Scopes` (classic tokens only). */
  scopes?: string[];
  expiresAt?: string;
  error?: string;
  /** `git ls-remote` per configured vault. */
  vaults: { id: string; repo: string; ok: boolean; error?: string }[];
}

export type Busy = 'none' | 'turn' | 'sync';

export interface VaultStatus {
  state: VaultState;
  changedCount: number;
  unpushedCount: number;
  /** Files inside the vault root that GitHub's branch changed since its last commit shared with HEAD (as of the last fetch). */
  incomingCount: number;
  /** Their vault-relative paths, at most INCOMING_PATHS_MAX; length === min(incomingCount, INCOMING_PATHS_MAX). */
  incomingPaths: string[];
  busy: Busy;
  /** Vault-root-relative paths that are still unresolved while in Conflict. */
  conflictPaths: string[];
  /** Set when the last pull or background fetch couldn't reach GitHub (git's error, redacted). */
  pullError?: string;
}

/** Cap on `VaultStatus.incomingPaths`, so a status event stays small after a remote replacement (#36). */
export const INCOMING_PATHS_MAX = 200;

export interface FileEntry {
  /** Vault-root-relative, `/`-separated. */
  path: string;
  type: 'file' | 'dir';
  /** Files only, epoch ms. Last modified: mtime when uncommitted, else the last commit time. */
  modified?: number;
  /** Files only, epoch ms. Last change the AI made (its edit stamp). */
  ai?: number;
  /** Files only, epoch ms. Newer of the human edit stamp and the last commit without the AI trailer. */
  human?: number;
}

export interface FileContent {
  path: string;
  /** '' for binary files. */
  content: string;
  /** Not valid UTF-8 text (or contains NUL): show, never edit. */
  binary: boolean;
  /** Content hash; send back as `version` on PUT. */
  version: string;
}

/** `POST /vaults/:id/raw` (upload): where the file landed. */
export interface UploadResult {
  path: string;
  version: string;
  size: number;
  /** The note was flat and moved into its own folder first. */
  moved?: { from: string; to: string };
  /** Pages whose path-form links to the moved note were rewritten. */
  rewritten?: string[];
}

export interface PutFileRequest {
  content: string;
  /** Version the editor loaded; null when creating a new file. */
  version: string | null;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface Change {
  path: string;
  kind: ChangeKind;
  /** Current content version (null = deleted); pass to Discard so it can't hit a newer edit. */
  version?: string | null;
}

export interface Diff {
  path: string;
  diff: string;
}

export type ConflictChoice = 'mine' | 'theirs' | 'both';

export interface CommitResult {
  /** Commit hash, or null when nothing was committed. */
  commit: string | null;
  pushed: boolean;
  pushError?: string;
}

/** Live vault event stream (`GET /vaults/:id/events`), one JSON object per line. */
export type VaultEvent =
  | { type: 'status'; status: VaultStatus }
  | { type: 'files-changed'; files: { path: string; version: string | null }[] };

// ---- Chat (ACP-shaped: session / prompt / update / tool_call / permission) ----

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  turn: TurnState;
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'denied';

export interface ToolCall {
  id: string;
  tool: string;
  status: ToolStatus;
  /** Vault-root-relative path the tool reads/changes, if any. */
  path?: string;
  /** True when the tool changes files (edit/write/patch). */
  writes: boolean;
  /** True when the tool asks the UI to show `path` (open_note). */
  opens?: boolean;
  title?: string;
  error?: string;
  /** websearch: the search query. */
  query?: string;
  /** webfetch: the fetched URL. */
  url?: string;
}

export type ChatPart =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool'; id: string; call: ToolCall }
  /** A file sent with a prompt (chat attachment): its vault path, never its bytes. */
  | { type: 'file'; id: string; path: string; mime: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  createdAt: number;
  /** `provider/model` the turn actually ran with. */
  model?: string;
  error?: string;
}

export interface ChatDetail {
  id: string;
  title: string;
  messages: ChatMessage[];
  turn: TurnState;
  /** The prompt text while its turn is still queued (not yet sent to the harness). */
  queuedText?: string;
}

export type TurnState = 'idle' | 'queued' | 'running';

/** Chat stream (`GET /vaults/:id/chats/:chatId/stream`), one JSON object per line. */
export type ChatEvent =
  /** `waiting`: what a queued turn waits for — another chat's turn, or a sync (pull/commit/…). */
  | { type: 'turn'; state: TurnState; readonly?: boolean; waiting?: 'turn' | 'sync' }
  | { type: 'message'; message: Omit<ChatMessage, 'parts'> }
  | { type: 'part'; messageId: string; part: ChatPart }
  | { type: 'text-delta'; messageId: string; partId: string; delta: string }
  | { type: 'error'; message: string };

export interface ApiError {
  error: string;
  code?: string;
}

export * from './media.js';
export * from './wikilink.js';
export * from './relink.js';
