import { describe, expect, it } from 'vitest';
import { buckets, burndown, forecast, inLine } from './instagram-stats';

const H = 3600_000;
const now = new Date(2026, 10, 1, 9, 30).getTime(); // 1 Nov 2026, 09:30 local
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('inLine', () => {
  it('counts what still has to be scraped: waiting, leased and backing off', () => {
    expect(inLine({ waiting: 5, leased: 1, backingOff: 2, ready: 7, failed: 3 })).toBe(8);
  });
});

describe('buckets', () => {
  it('24 h: one bar per hour, the last one the current hour, empty hours zero', () => {
    const rows = buckets([iso(now - 10 * 60_000), iso(now - 20 * 60_000), iso(now - 2 * H), iso(now - 30 * H)], '24h', now);
    expect(rows).toHaveLength(24);
    expect(rows.at(-1)).toMatchObject({ count: 2, label: '09:00' });
    expect(rows.at(-3)).toMatchObject({ count: 1, label: '07:00' });
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(3); // the 30 h old one is outside
  });

  it('7 d and 30 d: one bar per day, the last one today', () => {
    const scraped = [iso(now - H), iso(now - 26 * H), iso(now - 26 * H), iso(now - 10 * 24 * H)];
    const week = buckets(scraped, '7d', now);
    expect(week).toHaveLength(7);
    expect(week.map((r) => r.count)).toEqual([0, 0, 0, 0, 0, 2, 1]);
    const month = buckets(scraped, '30d', now);
    expect(month).toHaveLength(30);
    expect(month.reduce((a, r) => a + r.count, 0)).toBe(4);
  });
});

describe('forecast', () => {
  it('the rate of the last 24 h (night pause included) carries the line on to the end', () => {
    const scraped = Array.from({ length: 48 }, (_, i) => iso(now - i * 30 * 60_000)); // 48 in the last 24 h
    const f = forecast(scraped, 96, now);
    expect(f.perHour).toBe(2);
    expect(f.endsAt).toBe(now + 48 * H);
  });

  it('no end while nothing was scraped in the last 24 h, and none needed with an empty line', () => {
    expect(forecast([iso(now - 30 * H)], 10, now)).toEqual({ perHour: 0, endsAt: null });
    expect(forecast([iso(now - H)], 0, now)).toEqual({ perHour: 1 / 24, endsAt: now });
  });
});

describe('burndown', () => {
  it('past: what was in line then (now + scraped since); then a straight line to zero at the end', () => {
    const scraped = [iso(now - 3 * H), iso(now - H)];
    const b = burndown(scraped, 10, now, '24h', now + 5 * H);
    expect(b.past[0]).toEqual({ t: now - 24 * H, v: 12 });
    expect(b.past.at(-1)).toEqual({ t: now, v: 10 });
    expect(b.past.find((p) => p.t === now - 2 * H)?.v).toBe(11);
    expect(b.future).toEqual([{ t: now, v: 10 }, { t: now + 5 * H, v: 0 }]);
  });

  it('no future without an end', () => {
    expect(burndown([], 3, now, '7d', null).future).toEqual([]);
  });
});
