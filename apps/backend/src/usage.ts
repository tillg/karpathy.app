import type { UsageReport, UsageSums } from '@karpathy/shared';
import type { UsageRow } from './harness/map.js';

/** Where the usage comes from: the harness's chats per vault directory. */
export interface UsageSource {
  vaults(): { id: string; name: string; dir: string }[];
  sessions(dir: string): Promise<{ id: string; updatedAt: number }[]>;
  usage(dir: string, sessionId: string): Promise<UsageRow[]>;
}

const CONCURRENCY = 4;

const zero = (): UsageSums => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (to: UsageSums, r: UsageSums) => {
  to.input += r.input;
  to.output += r.output;
  to.reasoning += r.reasoning;
  to.cacheRead += r.cacheRead;
  to.cacheWrite += r.cacheWrite;
  to.cost += r.cost;
};
const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM-DD` in the process timezone (`TZ`). */
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Token usage and cost of the chats that still exist (admin mode, Usage). A chat's messages are read only when its
 * updated time moved since the last report, as `lastEntries` does for the chat list.
 */
export class UsageService {
  private cache = new Map<string, { updated: number; rows: UsageRow[] }>();

  constructor(private source: UsageSource, private now: () => number) {}

  async report(days: number): Promise<UsageReport> {
    const today = new Date(this.now());
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1)).getTime();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();

    const perVault = await Promise.all(this.source.vaults().map(async (v) => ({ v, rows: await this.vaultRows(v.dir) })));

    const byDay = new Map<string, UsageSums>();
    for (let i = 0; i < days; i++) byDay.set(dateOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1) + i)), zero());
    const byModel = new Map<string, UsageSums>();
    const total = zero();
    const byVault: UsageReport['byVault'] = [];
    for (const { v, rows } of perVault) {
      const sums = zero();
      let chats = 0;
      for (const chat of rows) {
        const inRange = chat.filter((r) => r.created >= start && r.created < end);
        if (inRange.length) chats++;
        for (const r of inRange) {
          add(sums, r);
          add(total, r);
          const day = byDay.get(dateOf(new Date(r.created)));
          if (day) add(day, r);
          let m = byModel.get(r.model);
          if (!m) byModel.set(r.model, (m = zero()));
          add(m, r);
        }
      }
      byVault.push({ vault: v.id, name: v.name, chats, ...sums });
    }
    return {
      days: [...byDay].map(([date, s]) => ({ date, ...s })),
      byModel: [...byModel].map(([model, s]) => ({ model, ...s })).sort((a, b) => b.input + b.output - (a.input + a.output)),
      byVault,
      total,
      costKnown: total.cost > 0,
    };
  }

  /** The cached rows of every chat in `dir`, one array per chat. */
  private async vaultRows(dir: string): Promise<UsageRow[][]> {
    const sessions = await this.source.sessions(dir);
    const key = (id: string) => `${dir}\0${id}`;
    const todo = sessions.filter((s) => this.cache.get(key(s.id))?.updated !== s.updatedAt);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const s = todo[next++]!;
        try {
          this.cache.set(key(s.id), { updated: s.updatedAt, rows: await this.source.usage(dir, s.id) });
        } catch { /* left out of this report; tried again on the next */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    const ids = new Set(sessions.map((s) => key(s.id)));
    for (const k of this.cache.keys()) if (k.startsWith(`${dir}\0`) && !ids.has(k)) this.cache.delete(k);
    return sessions.map((s) => this.cache.get(key(s.id))?.rows ?? []);
  }
}
