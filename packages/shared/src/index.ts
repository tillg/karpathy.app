import type { BrowserCall } from './browser-call.js';
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
  /** `provider/model`; the default comes from deploy/settings/ (`ai.model`). */
  model: string;
  /** Writes the chat titles (#148); the default comes from `ai.title_model`. '' = the chat model in effect. */
  titleModel: string;
  /** The model of look_at_image, `<vision gateway>/<model>`; the default comes from `ai.vision_model`. */
  visionModel: string;
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
  /** The deployment's default model (deploy/settings/ `ai.model`). */
  defaultModel: string;
  /** `model` is the Admin's choice, not the default. */
  modelOverridden: boolean;
  defaultTitleModel: string;
  titleModelOverridden: boolean;
  defaultVisionModel: string;
  visionModelOverridden: boolean;
  /** The gateway every vision model must be on (its id is the model's prefix); '' when unknown. */
  visionGateway: string;
  githubToken: { source: 'settings' | 'secret' | 'none'; last4: string | null };
  /** What the current model reads; null when opencode is down or doesn't list the model. */
  modelInput: ModelInput | null;
}

/** One entry of `GET /settings/secrets`: a secret the deployment references, never its value. */
export interface SecretStatus {
  name: string;
  /** The component that reads it (backend, opencode, ...). */
  component: string;
  purpose: string;
  optional: boolean;
  /** Non-empty as of the last settings render. */
  set: boolean;
  /** `github_token` only: where the token in use comes from (absent when none). */
  source?: 'app' | 'deployment';
  /** `github_token` only: the last 4 characters of the token in use. */
  last4?: string;
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

/** What an Instagram worker last reported by heartbeat (deploy/ingest/server.py `WORKER_STATES`). */
export type InstagramWorkerState = 'idle' | 'scraping' | 'night' | 'resting' | 'needs-login' | 'rate-limited' | 'error';

/** One Instagram worker as the ingest service last heard from it; `lastSeen` is an ISO time. */
export interface InstagramWorker {
  name: string;
  version: string;
  state: InstagramWorkerState;
  message?: string;
  lastSeen: string;
}

/** Worker mode: the wanted shortcodes by job state (`ready` = scraped, the resolver picks it up next). */
export interface InstagramQueue {
  waiting: number;
  leased: number;
  backingOff: number;
  ready: number;
  failed: number;
}

/**
 * Admin › Instagram (`GET /ingest/instagram`, disconnect): the ingest service's Instagram session. `waitingLinks`
 * counts Instagram links in the vaults' Input/ that wait for a session (worker mode: for a worker); `via` says where
 * a pending login's code went. `source` says who scrapes: the server itself (`local`) or workers on the user's
 * machines (`worker`, which adds `workers`, seen in the last 30 days, newest first, and the job `queue`).
 */
export interface InstagramStatus {
  state: 'not-connected' | 'waiting-for-code' | 'connected' | 'expired';
  account?: string;
  via?: string;
  waitingLinks?: number;
  source?: 'local' | 'worker';
  workers?: InstagramWorker[];
  queue?: InstagramQueue;
}

/** The answer to a login or a code: connected, or Instagram wants a 2FA/challenge code (`via`: "SMS", "email", …). */
export type InstagramLoginAnswer = { state: 'connected'; account: string } | { state: 'code'; via: string };

/** The ingest queue: `Input/` in the vault root, one sub-folder per source not yet ingested. */
export const INPUT_DIR = 'Input';

export interface VaultStatus {
  state: VaultState;
  changedCount: number;
  /** The part of `changedCount` under `Input/` (the ingest queue): left out of the commit reminder. */
  inputChangedCount: number;
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

/** Longest search text `GET /vaults/:id/search` accepts (characters); longer → 400 `query-too-long`. */
export const MAX_SEARCH_QUERY = 500;

/** One result line of `GET /vaults/:id/search`; `line` 0 = found by file name or path only (`text` is the path). */
export interface SearchHit {
  path: string;
  line: number;
  text: string;
  /** The matched words in `text` as [start, end) offsets (stems and folded forms included, so not always the query text). */
  ranges?: [number, number][];
}

/** `GET /vaults/:id/graph`: the notes (`.md` files, with their frontmatter `type` if set) and the links between them. */
export interface GraphData {
  nodes: { path: string; type?: string }[];
  links: { source: string; target: string }[];
}

/** A table cell of a base (#91): a value, a link to a vault file, or a list of cells. Dates come as `YYYY-MM-DD[ HH:mm]`. */
export type BaseCell = string | number | boolean | null | { link: string; text: string } | BaseCell[];

/** The table a fenced ```base block (Obsidian Bases syntax, v1 subset) evaluates to (`POST /vaults/:id/base`). */
export interface BaseResult {
  /** The view's `name`, if it has one. */
  view: string | null;
  columns: { id: string; label: string }[];
  rows: { path: string; cells: BaseCell[] }[];
  /** Matching files before `limit` and the row cap. */
  total: number;
  /** What was left out (e.g. `groupBy`, further views), for a note under the table. */
  notices: string[];
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

/**
 * A possible secret in the changes a commit would record (#141). Never carries the secret: `masked` shows at most its
 * first four characters.
 */
export interface SecretFinding {
  /** Vault-relative path (repo-relative when outside the vault root), or `Commit message`. */
  file: string;
  /** 1-based; 0 for a file too large to scan (rule `too-large-to-scan`). */
  line: number;
  /** The gitleaks rule, e.g. `github-pat`, `generic-api-key`, or `too-large-to-scan`. */
  rule: string;
  description: string;
  /** At most the first four characters, then `…`; empty for a file too large to scan. */
  masked: string;
  /**
   * Opaque id of this finding (a keyed hash of file, rule and the secret itself, so another secret on the same line
   * is a new finding); "commit anyway" sends back the ones the user saw. Valid until the backend restarts.
   */
  fingerprint: string;
}

export interface CommitResult {
  /** Commit hash, or null when nothing was committed. */
  commit: string | null;
  pushed: boolean;
  pushError?: string;
}

/** What the automatic move to the `.agents` standard did in a vault (uncommitted changes). */
export interface AgentsMove {
  /** Skill folders moved from `.claude/skills/` to `.agents/skills/`. */
  moved: string[];
  /** `.claude/commands/<name>.md` turned into skills. */
  converted: string[];
  /** AGENTS.md written from CLAUDE.md (or the CLAUDE.md pointer written). */
  instructions: boolean;
  /** Files pasted into AGENTS.md; they stay where they are. */
  inlined: string[];
  /** Names not moved because they exist already (`AGENTS.md` for the instructions). */
  skipped: string[];
}

/** Live vault event stream (`GET /vaults/:id/events`), one JSON object per line. */
export type VaultEvent =
  | { type: 'status'; status: VaultStatus }
  | { type: 'files-changed'; files: { path: string; version: string | null }[] }
  /** `at`: when the move ran (ms), so a client shows each move once. */
  | ({ type: 'agents-move'; at: number } & AgentsMove)
  /** A browser tool waits for the tab `call.tabId` (#151). */
  | { type: 'browser-call'; call: BrowserCall }
  /** The call was answered, timed out or its turn ended: stop answering it. */
  | { type: 'browser-call-done'; callId: string }
  /** A chat's title changed or a drift check suggests a new one (#148); no `titleSuggestion` = none pending. */
  | { type: 'chat-title'; chatId: string; title: string; titleSuggestion?: string };

// ---- Chat (ACP-shaped: session / prompt / update / tool_call / permission) ----

/** A skill the chat can start by name (`/name`): a vault skill or an app skill. */
export interface Command {
  name: string;
  description: string;
  /** `vault`: from the vault's skill folder `.agents/skills/`; `app`: ships with karpathy.app (every vault). */
  source: 'vault' | 'app';
  /** On a vault skill: it replaces karpathy.app's skill of the same name, which doesn't run in this vault. */
  replaces?: true;
}

/** Tokens the chat's last AI reply used, against its model's context window (opencode `limit.context`; #140). */
export interface ContextUsage {
  used: number;
  /** Unknown when the provider config doesn't say. */
  limit?: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Time of the chat's last message, any role; absent until the backend has looked (#140). */
  lastEntryAt?: number;
  /** From the last AI reply; absent before the first one. */
  context?: ContextUsage;
  turn: TurnState;
  /** A drift check's new title, until the user renames or keeps (#148). */
  titleSuggestion?: string;
}

/** The file the user has open when a prompt is sent (#143); the AI reads it through its `current_page` tool. */
export interface OpenPage {
  /** Vault-root-relative path. */
  path: string;
  /** The view the file shows in. */
  mode: 'read' | 'write';
  /** Edits not saved yet: the AI reads the saved text. */
  unsaved: boolean;
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
  /** suggest_next: the suggested next prompt (shown as ghost text in the composer, not as a chip). */
  suggestion?: string;
  /** A browser tool (#151): its answer comes from the tab that sent the prompt; `callId` matches its `browser-call` event. */
  browser?: boolean;
  callId?: string;
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

/**
 * Where a chat error came from (#169): the tool that was running when it happened, or the model's own
 * request (no tool running, e.g. the provider is out of credits).
 */
export type ErrorOrigin = { kind: 'tool'; tool: string } | { kind: 'model' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: ChatPart[];
  createdAt: number;
  /** `provider/model` the turn actually ran with. */
  model?: string;
  /** AI replies with tokens: how full the chat's context is after this reply. */
  context?: ContextUsage;
  error?: string;
  /** Set with `error` unless the turn was stopped. */
  errorOrigin?: ErrorOrigin;
}

export interface ChatDetail {
  id: string;
  title: string;
  messages: ChatMessage[];
  turn: TurnState;
  /** The chat's prompts waiting for their turn, oldest first (not yet sent to the harness, #155). */
  queued: QueuedPrompt[];
  titleSuggestion?: string;
}

/** A prompt waiting in the vault's turn queue (#155): sent while a turn ran, or before its own turn started. */
export interface QueuedPrompt {
  id: string;
  text: string;
  /** Vault paths of the files sent with it. */
  attachments?: string[];
}

/** A queued prompt taken back (DELETE, or Stop): its text and its files as composer chips, so ✕ can still delete them. */
export interface ReturnedPrompt {
  id: string;
  text: string;
  /** The files that still exist; one gone meanwhile is left out. */
  attachments: { path: string; version: string; mime: string; size: number }[];
}

/** How many prompts one chat may have waiting (#155). */
export const MAX_QUEUED = 10;

export type TurnState = 'idle' | 'queued' | 'running';

/** Chat stream (`GET /vaults/:id/chats/:chatId/stream`), one JSON object per line. */
export type ChatEvent =
  /** `waiting`: what a queued turn waits for — another chat's turn, or a sync (pull/commit/…). */
  | { type: 'turn'; state: TurnState; readonly?: boolean; waiting?: 'turn' | 'sync' }
  | { type: 'message'; message: Omit<ChatMessage, 'parts'> }
  | { type: 'part'; messageId: string; part: ChatPart }
  | { type: 'text-delta'; messageId: string; partId: string; delta: string }
  /** `origin`: the harness's error (#169); absent for the backend's own errors (pull failed, …), which name their cause. */
  | { type: 'error'; message: string; origin?: ErrorOrigin }
  /** The chat's queued prompts changed (#155); `started`: the prompt that just left the queue to run. */
  | { type: 'queue'; queued: QueuedPrompt[]; started?: string };

/** Token and cost sums (`GET /usage`). */
export interface UsageSums {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface UsageReport {
  /** One entry per day of the range in the server's timezone, zeros included, oldest first. */
  days: ({ date: string } & UsageSums)[];
  byModel: ({ model: string } & UsageSums)[];
  /** `vault` is the vault id; `chats` counts the chats with usage in the range. */
  byVault: ({ vault: string; name: string; chats: number } & UsageSums)[];
  total: UsageSums;
  /** False when every cost is 0 (the provider reports none): the UI hides the cost column. */
  costKnown: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
}

export * from './browser-call.js';
export * from './media.js';
export * from './wikilink.js';
export * from './relink.js';

/** One reading of the server (admin mode, Server section); taken every 30 s by the backend. */
/** The ranges `GET /metrics` serves. */
export type MetricsRange = '1h' | '24h' | '7d';
/** The windows `GET /usage` serves. */
export type UsageDays = 7 | 30;

export interface MetricsSample {
  /** Epoch ms. */
  at: number;
  /** Busy share of all CPUs since the previous sample, 0-100. */
  cpu: number;
  memUsed: number;
  memTotal: number;
  /** 1-minute load average. */
  load1: number;
  vaultsUsed: number;
  vaultsTotal: number;
  configUsed: number;
  configTotal: number;
  opencodeUp: boolean;
}

/** `GET /metrics?range=`: `samples` is bucket-averaged to at most 240 points. */
export interface MetricsReport {
  samples: MetricsSample[];
  latest: MetricsSample | null;
  /** Backend uptime in seconds. */
  uptimeS: number;
  intervalS: number;
}
