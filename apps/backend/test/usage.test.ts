import { afterEach, describe, expect, it } from 'vitest';
import type { UsageRow } from '../src/harness/map.js';
import { UsageService, type UsageSource } from '../src/usage.js';

const tz = process.env.TZ;
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

const row = (created: number, model: string, input: number, cost = 0): UsageRow => ({ created, model, input, output: input * 2, reasoning: 1, cacheRead: 10, cacheWrite: 5, cost });

/** In-memory sessions per vault dir; counts the usage reads. */
function source(data: Record<string, Record<string, { updatedAt: number; rows: UsageRow[] }>>) {
  const reads: string[] = [];
  const src: UsageSource = {
    vaults: () => Object.keys(data).map((id) => ({ id, name: id.toUpperCase(), dir: `/v/${id}` })),
    sessions: async (dir) => Object.entries(data[dir.slice(3)]!).map(([id, s]) => ({ id, updatedAt: s.updatedAt })),
    usage: async (dir, id) => (reads.push(id), data[dir.slice(3)]![id]!.rows),
  };
  return { src, reads, data };
}

describe('UsageService', () => {
  it('sums by day in the process timezone (TZ, rendered from the timezone setting), by model and by vault', async () => {
    process.env.TZ = 'Pacific/Auckland'; // UTC+13 in January (NZDT)
    const at = (iso: string) => Date.parse(iso);
    // Local day 2026-01-10 holds 2026-01-09T11:00Z .. 2026-01-10T10:59Z.
    const { src } = source({
      a: { s1: { updatedAt: 1, rows: [row(at('2026-01-09T13:00:00Z'), 'p/m1', 100, 0.5), row(at('2026-01-10T10:59:00Z'), 'p/m2', 10, 0.25), row(at('2026-01-10T12:30:00Z'), 'p/m1', 1)] } },
      b: { s2: { updatedAt: 1, rows: [row(at('2026-01-10T01:00:00Z'), 'p/m1', 1000)] }, s3: { updatedAt: 1, rows: [row(at('2026-01-08T01:00:00Z'), 'p/m1', 7)] } },
    });
    const r = await new UsageService(src, () => at('2026-01-10T20:00:00Z')).report(7);
    // now is 2026-01-11 09:00 local, so the range is 01-05..01-11.
    expect(r.days.map((d) => d.date)).toEqual(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11']);
    const by = Object.fromEntries(r.days.map((d) => [d.date, d.input]));
    expect(by).toEqual({ '2026-01-05': 0, '2026-01-06': 0, '2026-01-07': 0, '2026-01-08': 7, '2026-01-09': 0, '2026-01-10': 100 + 10 + 1000, '2026-01-11': 1 });
    expect(r.days[5]).toMatchObject({ output: 2220, reasoning: 3, cacheRead: 30, cacheWrite: 15, cost: 0.75 });
    expect(r.byModel).toEqual([
      { model: 'p/m1', input: 1108, output: 2216, reasoning: 4, cacheRead: 40, cacheWrite: 20, cost: 0.5 },
      { model: 'p/m2', input: 10, output: 20, reasoning: 1, cacheRead: 10, cacheWrite: 5, cost: 0.25 },
    ]);
    expect(r.byVault).toEqual([
      { vault: 'a', name: 'A', chats: 1, input: 111, output: 222, reasoning: 3, cacheRead: 30, cacheWrite: 15, cost: 0.75 },
      { vault: 'b', name: 'B', chats: 2, input: 1007, output: 2014, reasoning: 2, cacheRead: 20, cacheWrite: 10, cost: 0 },
    ]);
    expect(r.total).toEqual({ input: 1118, output: 2236, reasoning: 5, cacheRead: 50, cacheWrite: 25, cost: 0.75 });
    expect(r.costKnown).toBe(true);
  });

  it('counts only messages created inside the range', async () => {
    process.env.TZ = 'UTC';
    const now = Date.parse('2026-03-31T10:00:00Z');
    const { src } = source({ a: { s: { updatedAt: 1, rows: [row(Date.parse('2026-03-24T23:59:59Z'), 'p/m', 1), row(Date.parse('2026-03-25T00:00:00Z'), 'p/m', 2), row(Date.parse('2026-04-01T00:00:00Z'), 'p/m', 4)] } } });
    const svc = new UsageService(src, () => now);
    expect((await svc.report(7)).total.input).toBe(2);
    expect((await svc.report(30)).total.input).toBe(3);
    expect((await svc.report(30)).days).toHaveLength(30);
  });

  it('re-reads only sessions whose time.updated changed', async () => {
    process.env.TZ = 'UTC';
    const now = Date.parse('2026-03-31T10:00:00Z');
    const { src, reads, data } = source({ a: { s1: { updatedAt: 1, rows: [row(now, 'p/m', 1)] }, s2: { updatedAt: 1, rows: [row(now, 'p/m', 2)] } } });
    const svc = new UsageService(src, () => now);
    expect((await svc.report(7)).total.input).toBe(3);
    expect(reads.sort()).toEqual(['s1', 's2']);
    await svc.report(30);
    expect(reads).toHaveLength(2);
    data.a!.s2 = { updatedAt: 2, rows: [row(now, 'p/m', 20)] };
    expect((await svc.report(7)).total.input).toBe(21);
    expect(reads.sort()).toEqual(['s1', 's2', 's2']);
    delete data.a!.s1; // a deleted chat no longer counts
    expect((await svc.report(7)).total.input).toBe(20);
  });

  it('costKnown is false when every cost is 0', async () => {
    process.env.TZ = 'UTC';
    const now = Date.parse('2026-03-31T10:00:00Z');
    const { src } = source({ a: { s: { updatedAt: 1, rows: [row(now, 'p/m', 1)] } } });
    expect((await new UsageService(src, () => now).report(7)).costKnown).toBe(false);
  });
});
