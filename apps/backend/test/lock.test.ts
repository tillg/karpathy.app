import { describe, expect, it } from 'vitest';
import { VaultLock } from '../src/lock.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('VaultLock', () => {
  it('lets shared holders overlap', async () => {
    const lock = new VaultLock();
    const a = await lock.acquireShared('save');
    const b = await lock.acquireShared('turn');
    expect(lock.busy).toBe('turn');
    a();
    b();
    expect(lock.isFree).toBe(true);
  });

  it('exclusive waits for running shared holders and blocks new ones', async () => {
    const lock = new VaultLock();
    const order: string[] = [];
    const save = await lock.acquireShared('save');
    const ex = lock.acquireExclusive().then((r) => {
      order.push('exclusive');
      return r;
    });
    const later = lock.acquireShared('save').then((r) => {
      order.push('later-save');
      return r;
    });
    await tick();
    expect(order).toEqual([]);
    expect(lock.busy).toBe('sync');
    save();
    const releaseEx = await ex;
    await tick();
    expect(order).toEqual(['exclusive']);
    releaseEx();
    (await later)();
    expect(order).toEqual(['exclusive', 'later-save']);
  });

  it('tryExclusive is null when not immediately free', async () => {
    const lock = new VaultLock();
    const s = await lock.acquireShared('turn');
    expect(lock.tryExclusive()).toBeNull();
    s();
    const r = lock.tryExclusive();
    expect(r).not.toBeNull();
    r!();
  });

  it('exclusiveThenShared keeps queued exclusives out until the shared part ends', async () => {
    const lock = new VaultLock();
    const order: string[] = [];
    const turn = lock.exclusiveThenShared('turn', async () => {
      order.push('pull');
      lock.acquireExclusive().then((r) => {
        order.push('commit');
        r();
      });
      await tick();
    });
    const releaseTurn = await turn;
    await tick();
    expect(order).toEqual(['pull']);
    expect(lock.busy).toBe('turn');
    releaseTurn();
    await tick();
    expect(order).toEqual(['pull', 'commit']);
  });

  it('releases the exclusive lock when the exclusive part throws', async () => {
    const lock = new VaultLock();
    await expect(lock.exclusiveThenShared('turn', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.isFree).toBe(true);
  });

  it('tryShared grants next to shared holders, refuses while exclusive holds or waits', async () => {
    const lock = new VaultLock();
    const f1 = lock.tryShared('fetch');
    expect(f1).not.toBeNull();
    expect(lock.busy).toBe('none');
    f1!();
    const turn = await lock.acquireShared('turn');
    const f2 = lock.tryShared('fetch');
    expect(f2).not.toBeNull();
    expect(lock.busy).toBe('turn');
    f2!();
    turn();
    const ex = await lock.acquireExclusive();
    expect(lock.tryShared('fetch')).toBeNull();
    ex();
    const save = await lock.acquireShared('save');
    const queued = lock.acquireExclusive();
    expect(lock.tryShared('fetch')).toBeNull();
    save();
    (await queued)();
    // A running fetch makes an exclusive op wait until it ends.
    const fetch = lock.tryShared('fetch')!;
    let got = false;
    const exP = lock.acquireExclusive().then((r) => { got = true; return r; });
    await tick();
    expect(got).toBe(false);
    fetch();
    (await exP)();
    expect(got).toBe(true);
    expect(lock.isFree).toBe(true);
  });

  it('a fetch holder alone does not notify listeners (no status event per tick)', async () => {
    const lock = new VaultLock();
    let n = 0;
    lock.onChange(() => n++);
    lock.tryShared('fetch')!();
    expect(n).toBe(0);
  });
});
