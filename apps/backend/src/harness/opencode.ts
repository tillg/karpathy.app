import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { ChatMessage, ChatSummary, ModelInput } from '@karpathy/shared';
import { mapEvent, mapMessages, writtenPaths, type HarnessEvent } from './map.js';

export type AgentName = 'vault' | 'vault-readonly' | 'commit-message';

export interface PromptInput {
  text: string;
  agent: AgentName;
  /** `provider/model`, split at the first `/`. */
  model: string;
  /** Per-turn tool switches (`{ websearch: true }`); opencode stores them as session permission rules. */
  tools?: Record<string, boolean>;
  /** Files sent with the prompt: vault path (the part's file name), `file:` URL as the harness sees it, type. */
  files?: { path: string; url: string; mime: string }[];
}

/** The prompt as opencode parts: the text (left out when empty), then one file part per attachment. */
const promptParts = (input: PromptInput) => [
  ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
  ...(input.files ?? []).map((f) => ({ type: 'file' as const, mime: f.mime, filename: f.path, url: f.url })),
];

/** Everything the backend needs from the agent harness. `dir` = vault root as the harness sees it. */
export interface Harness {
  health(): Promise<boolean>;
  listSessions(dir: string): Promise<Omit<ChatSummary, 'turn'>[]>;
  createSession(dir: string, title?: string): Promise<string>;
  sessionExists(dir: string, id: string): Promise<boolean>;
  messages(dir: string, id: string): Promise<ChatMessage[]>;
  deleteSession(dir: string, id: string): Promise<void>;
  setTitle(dir: string, id: string, title: string): Promise<void>;
  prompt(dir: string, id: string, input: PromptInput): Promise<void>;
  /** Runs a turn to completion and returns the assistant's text. */
  promptSync(dir: string, id: string, input: PromptInput, signal?: AbortSignal): Promise<string>;
  abort(dir: string, id: string): Promise<void>;
  busySessions(dir: string): Promise<string[]>;
  /** The models the harness can run (providers with credentials): `provider/model` and what they read. */
  models(): Promise<{ id: string; input: ModelInput }[]>;
  /** One event subscription per directory; reconnects until stopped, only while `mayConnect()`. */
  subscribe(dir: string, onEvent: (e: HarnessEvent) => void, mayConnect?: () => boolean): () => void;
}

/** HTTP Basic auth header for the opencode server (user `opencode`). */
export const basicAuth = (password: string) => ({ Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` });

function splitModel(model: string) {
  const i = model.indexOf('/');
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

function unwrap<T>(r: { data?: T; error?: unknown; response?: Response }, what: string): T {
  if (r.error !== undefined || r.data === undefined) {
    const msg = typeof r.error === 'object' && r.error ? JSON.stringify(r.error) : String(r.error ?? `HTTP ${r.response?.status}`);
    throw new Error(`opencode ${what} failed: ${msg}`);
  }
  return r.data;
}

export class OpencodeHarness implements Harness {
  private c: OpencodeClient;

  /** `password` = the opencode server password (HTTP Basic, user `opencode`); none = no auth. */
  constructor(baseUrl: string, password?: string) {
    this.c = createOpencodeClient({ baseUrl, ...(password ? { headers: basicAuth(password) } : {}) });
  }

  async health() {
    const r = await this.c.global.health({ signal: AbortSignal.timeout(3000) } as never);
    return Boolean((r.data as { healthy?: boolean } | undefined)?.healthy);
  }

  async listSessions(dir: string): Promise<Omit<ChatSummary, 'turn'>[]> {
    const list = unwrap(await this.c.session.list({ directory: dir, roots: true, limit: 200 }), 'session.list');
    return list
      .filter((s) => !s.parentID && s.directory === dir)
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.time.updated }));
  }

  async createSession(dir: string, title?: string) {
    return unwrap(await this.c.session.create({ directory: dir, ...(title ? { title } : {}) }), 'session.create').id;
  }

  async sessionExists(dir: string, id: string) {
    const r = await this.c.session.get({ directory: dir, sessionID: id });
    return r.data !== undefined && (r.data as { directory?: string }).directory === dir;
  }

  async messages(dir: string, id: string) {
    return mapMessages(unwrap(await this.c.session.messages({ directory: dir, sessionID: id }), 'session.messages'), dir);
  }

  async deleteSession(dir: string, id: string) {
    unwrap(await this.c.session.delete({ directory: dir, sessionID: id }), 'session.delete');
  }

  async setTitle(dir: string, id: string, title: string) {
    unwrap(await this.c.session.update({ directory: dir, sessionID: id, title }), 'session.update');
  }

  async prompt(dir: string, id: string, input: PromptInput) {
    const r = await this.c.session.promptAsync({
      directory: dir,
      sessionID: id,
      agent: input.agent,
      model: splitModel(input.model),
      parts: promptParts(input),
      ...(input.tools ? { tools: input.tools } : {}),
    });
    if (r.error !== undefined) throw new Error(`opencode prompt failed: ${JSON.stringify(r.error)}`);
  }

  async promptSync(dir: string, id: string, input: PromptInput, signal?: AbortSignal) {
    const data = unwrap(
      await this.c.session.prompt(
        { directory: dir, sessionID: id, agent: input.agent, model: splitModel(input.model), parts: [{ type: 'text', text: input.text }], ...(input.tools ? { tools: input.tools } : {}) },
        signal ? ({ signal } as never) : undefined,
      ),
      'session.prompt',
    ) as { info?: { error?: unknown }; parts?: { type: string; text?: string }[] };
    if (data.info?.error) throw new Error(`opencode prompt failed: ${JSON.stringify(data.info.error)}`);
    return (data.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('').trim();
  }

  async abort(dir: string, id: string) {
    await this.c.session.abort({ directory: dir, sessionID: id });
  }

  async busySessions(dir: string) {
    const st = unwrap(await this.c.session.status({ directory: dir }), 'session.status') as Record<string, { type: string }>;
    return Object.entries(st)
      .filter(([, s]) => s.type !== 'idle')
      .map(([id]) => id);
  }

  async models() {
    type M = { capabilities?: { input?: { image?: boolean; pdf?: boolean } } };
    const data = unwrap(await this.c.config.providers(), 'config.providers') as { providers: { id: string; models: Record<string, M> }[] };
    return data.providers.flatMap((p) => Object.entries(p.models).map(([m, info]) => ({
      id: `${p.id}/${m}`,
      input: { image: !!info.capabilities?.input?.image, pdf: !!info.capabilities?.input?.pdf },
    })));
  }

  subscribe(dir: string, onEvent: (e: HarnessEvent) => void, mayConnect: () => boolean = () => true): () => void {
    const ctrl = new AbortController();
    const loop = async () => {
      while (!ctrl.signal.aborted) {
        if (!mayConnect()) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        try {
          const sub = await this.c.event.subscribe({ directory: dir }, { signal: ctrl.signal, sseMaxRetryAttempts: 1 } as never);
          for await (const raw of sub.stream) {
            const e = mapEvent(raw, dir);
            if (e) onEvent(e);
            // Cross-check for the AI-touched set: completed write tools carry their paths too.
            const r = raw as { type?: string; properties?: { part?: Record<string, unknown> } };
            if (r.type === 'message.part.updated' && r.properties?.part)
              for (const path of writtenPaths(r.properties.part, dir)) onEvent({ type: 'file-edited', path });
          }
        } catch {
          // reconnect below
        }
        if (!ctrl.signal.aborted) {
          onEvent({ type: 'status', sessionId: '', state: 'retry', message: 'event stream reconnect' });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void loop();
    return () => ctrl.abort();
  }
}
