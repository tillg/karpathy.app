import type { ChatMessage, ChatSummary, ContextUsage } from '@karpathy/shared';

/**
 * A chat's last entry and context usage for the chat list (#140). The list is polled every few seconds,
 * so a session's last messages are fetched only when its updated time moved since the last look.
 */
type Summary = Omit<ChatSummary, 'turn'>;
type Msg = Omit<ChatMessage, 'parts'>;
export type LastEntryCache = Map<string, { updated: number; lastEntryAt?: number; context?: ContextUsage }>;

const CONCURRENCY = 4;

export async function lastEntries(sessions: Summary[], cache: LastEntryCache, fetchLast: (id: string) => Promise<Msg[]>): Promise<Summary[]> {
  const todo = sessions.filter((s) => cache.get(s.id)?.updated !== s.updatedAt);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++]!;
      try {
        const msgs = await fetchLast(s.id);
        const lastEntryAt = msgs.reduce<number | undefined>((t, m) => (t === undefined || m.createdAt > t ? m.createdAt : t), undefined);
        const context = msgs.filter((m) => m.role === 'assistant' && m.context).at(-1)?.context;
        cache.set(s.id, { updated: s.updatedAt, ...(lastEntryAt !== undefined ? { lastEntryAt } : {}), ...(context ? { context } : {}) });
      } catch { /* shown without; tried again on the next list */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  const out = sessions.map((s) => {
    const c = cache.get(s.id);
    return { ...s, ...(c?.lastEntryAt !== undefined ? { lastEntryAt: c.lastEntryAt } : {}), ...(c?.context ? { context: c.context } : {}) };
  });
  const at = (s: Summary) => s.lastEntryAt ?? s.updatedAt;
  return out.sort((a, b) => at(b) - at(a));
}

/**
 * The context window per model (#140), from opencode's model list. A model not seen yet makes the next
 * lookup load the list; a failed load is tried again, a model the list lacks is looked up once.
 */
export class ModelLimits {
  limits = new Map<string, number>();
  private known = new Set<string>();
  private loading: Promise<boolean> | null = null;

  /** `load` fetches the model list and hands it to `set`. */
  constructor(private load: () => Promise<unknown>) {}

  set(models: { id: string; limit?: number }[]) {
    for (const m of models) this.known.add(m.id);
    this.limits = new Map(models.flatMap((m) => (m.limit ? [[m.id, m.limit] as const] : [])));
  }

  has(id: string) { return this.known.has(id); }

  async know(ids: (string | undefined)[]) {
    if (ids.every((id) => !id || this.known.has(id))) return;
    this.loading ??= this.load().then(() => true, () => false).finally(() => { this.loading = null; });
    if (await this.loading) for (const id of ids) if (id) this.known.add(id);
  }
}
