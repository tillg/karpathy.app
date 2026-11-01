import type { InstagramQueue } from '@karpathy/shared';

export type IgRange = '24h' | '7d' | '30d';

const H = 3600_000;
/** The rate behind the forecast: the last 24 h, so the worker's night pause (23–8 h) is part of it. */
const RATE_WINDOW = 24 * H;
/** Burndown sample step per range. */
const STEP: Record<IgRange, number> = { '24h': H, '7d': H, '30d': 6 * H };
const SPAN: Record<IgRange, number> = { '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H };

const ms = (scraped: string[]) => scraped.map((s) => Date.parse(s));

/** The posts still to be scraped: waiting, leased to a worker, or backing off after a failed try. */
export const inLine = (q: InstagramQueue) => q.waiting + q.leased + q.backingOff;

/** Scrapes per local hour (24 h) or local day (7 d, 30 d), oldest first; the last bucket is the current one. */
export function buckets(scraped: string[], range: IgRange, now: number) {
  const hourly = range === '24h';
  const n = hourly ? 24 : range === '7d' ? 7 : 30;
  const cur = new Date(now);
  if (hourly) cur.setMinutes(0, 0, 0);
  else cur.setHours(0, 0, 0, 0);
  const rows = Array.from({ length: n }, (_, i) => {
    const start = new Date(cur);
    if (hourly) start.setHours(start.getHours() - (n - 1 - i));
    else start.setDate(start.getDate() - (n - 1 - i));
    const end = new Date(start);
    if (hourly) end.setHours(end.getHours() + 1);
    else end.setDate(end.getDate() + 1);
    const label = hourly
      ? `${String(start.getHours()).padStart(2, '0')}:00`
      : start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { start: start.getTime(), end: end.getTime(), label, count: 0 };
  });
  for (const t of ms(scraped)) {
    const r = rows.find((x) => t >= x.start && t < x.end);
    if (r) r.count++;
  }
  return rows;
}

/** Scrapes per hour over the last 24 h, and when the line would be empty at that rate (null: no rate). */
export function forecast(scraped: string[], remaining: number, now: number) {
  const recent = ms(scraped).filter((t) => t > now - RATE_WINDOW && t <= now).length;
  const perHour = recent / 24;
  return { perHour, endsAt: perHour > 0 ? now + (remaining / perHour) * H : null };
}

/** What was in line over the range (now plus what was scraped since), then a straight line to zero at `endsAt`. */
export function burndown(scraped: string[], remaining: number, now: number, range: IgRange, endsAt: number | null) {
  const times = ms(scraped);
  const step = STEP[range];
  const n = SPAN[range] / step;
  const past = Array.from({ length: n + 1 }, (_, i) => {
    const t = now - (n - i) * step;
    return { t, v: remaining + times.filter((x) => x > t && x <= now).length };
  });
  const future = endsAt === null ? [] : [{ t: now, v: remaining }, { t: endsAt, v: 0 }];
  return { past, future };
}
