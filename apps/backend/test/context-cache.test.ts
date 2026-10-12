import type { ChatMessage } from '@karpathy/shared';
import { describe, expect, it } from 'vitest';
import { lastEntries, ModelLimits, type LastEntryCache } from '../src/harness/context-cache.js';

type Msg = Omit<ChatMessage, 'parts'>;
const user = (t: number): Msg => ({ id: `u${t}`, role: 'user', createdAt: t });
const ai = (t: number, used?: number): Msg => ({ id: `a${t}`, role: 'assistant', createdAt: t, ...(used ? { context: { used, limit: 1000 } } : {}) });

/** A plain fetch function that answers from a table and counts its calls. */
function fetcher(table: Record<string, Msg[]>) {
  const calls: string[] = [];
  return { calls, fetchLast: async (id: string) => { calls.push(id); return table[id] ?? []; } };
}

describe('last entry and context per chat (#140)', () => {
  it('a cold cache fetches each session once; unchanged sessions are not fetched again', async () => {
    const cache: LastEntryCache = new Map();
    const f = fetcher({ s1: [user(1), ai(2, 50)], s2: [user(3)] });
    const sessions = [{ id: 's1', title: 'a', updatedAt: 10 }, { id: 's2', title: 'b', updatedAt: 20 }];
    await lastEntries(sessions, cache, f.fetchLast);
    expect(f.calls.sort()).toEqual(['s1', 's2']);
    await lastEntries(sessions, cache, f.fetchLast);
    expect(f.calls).toHaveLength(2);
  });

  it('a changed session is fetched again, only that one', async () => {
    const cache: LastEntryCache = new Map();
    const f = fetcher({ s1: [ai(2, 50)], s2: [ai(3, 60)] });
    await lastEntries([{ id: 's1', title: 'a', updatedAt: 10 }, { id: 's2', title: 'b', updatedAt: 20 }], cache, f.fetchLast);
    await lastEntries([{ id: 's1', title: 'a', updatedAt: 11 }, { id: 's2', title: 'b', updatedAt: 20 }], cache, f.fetchLast);
    expect(f.calls.filter((c) => c === 's1')).toHaveLength(2);
    expect(f.calls.filter((c) => c === 's2')).toHaveLength(1);
  });

  it('lastEntryAt is the newest message of any role; context comes from the last AI reply', async () => {
    const f = fetcher({ s1: [ai(2, 50), user(5)] });
    const [c] = await lastEntries([{ id: 's1', title: 'a', updatedAt: 10 }], new Map(), f.fetchLast);
    expect(c).toEqual({ id: 's1', title: 'a', updatedAt: 10, lastEntryAt: 5, context: { used: 50, limit: 1000 } });
  });

  it('no AI reply → no context', async () => {
    const f = fetcher({ s1: [user(5)] });
    const [c] = await lastEntries([{ id: 's1', title: 'a', updatedAt: 10 }], new Map(), f.fetchLast);
    expect(c!.context).toBeUndefined();
    expect(c!.lastEntryAt).toBe(5);
  });

  it('sorted by last entry, falling back to the updated time, newest first', async () => {
    const f = fetcher({ old: [user(1)], renamed: [user(2)], fresh: [user(30)] });
    const out = await lastEntries([
      { id: 'renamed', title: 'r', updatedAt: 100 },
      { id: 'old', title: 'o', updatedAt: 5 },
      { id: 'fresh', title: 'f', updatedAt: 30 },
      { id: 'empty', title: 'e', updatedAt: 20 },
    ], new Map(), f.fetchLast);
    expect(out.map((c) => c.id)).toEqual(['fresh', 'empty', 'renamed', 'old']);
  });

  it('a failed fetch keeps the chat, without last entry or context', async () => {
    const out = await lastEntries([{ id: 's1', title: 'a', updatedAt: 10 }], new Map(), async () => { throw new Error('down'); });
    expect(out).toEqual([{ id: 's1', title: 'a', updatedAt: 10 }]);
  });
});

describe('context window per model (#140)', () => {
  /** A plain loader: answers with the given models (or fails) and counts its calls. */
  function limits(answers: (Array<{ id: string; limit?: number }> | Error)[]) {
    let calls = 0;
    const lim: ModelLimits = new ModelLimits(async () => {
      const a = answers[calls++]!;
      if (a instanceof Error) throw a;
      lim.set(a);
    });
    return { lim, calls: () => calls };
  }

  it('an unknown model loads the list once; then its limit is there', async () => {
    const { lim, calls } = limits([[{ id: 'p/m', limit: 1000 }]]);
    await lim.know(['p/m']);
    await lim.know(['p/m']);
    expect(calls()).toBe(1);
    expect(lim.limits.get('p/m')).toBe(1000);
  });

  it('a failed load is tried again on the next lookup', async () => {
    const { lim, calls } = limits([new Error('down'), [{ id: 'p/m', limit: 1000 }]]);
    await lim.know(['p/m']);
    expect(lim.limits.get('p/m')).toBeUndefined();
    await lim.know(['p/m']);
    expect(calls()).toBe(2);
    expect(lim.limits.get('p/m')).toBe(1000);
  });

  it('a model the list lacks is looked up once, also after a later list', async () => {
    const { lim, calls } = limits([[{ id: 'p/a', limit: 1 }], [{ id: 'p/a', limit: 1 }]]);
    await lim.know(['p/gone']);
    lim.set([{ id: 'p/a', limit: 1 }]);
    await lim.know(['p/gone']);
    expect(calls()).toBe(1);
  });
});
