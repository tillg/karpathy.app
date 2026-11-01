import type { InstagramStatus } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { buckets, burndown, forecast, inLine, type IgRange } from '../lib/instagram-stats';
import { Burndown } from './charts/Burndown';
import { StackedBars } from './charts/StackedBars';
import { Icon } from './Icon';
import { duration } from './ServerSection';

const RANGES: { id: IgRange; label: string; per: string }[] = [
  { id: '24h', label: '24 hours', per: 'hour' },
  { id: '7d', label: '7 days', per: 'day' },
  { id: '30d', label: '30 days', per: 'day' },
];
/** Refetched this often while shown and visible: a worker scrapes about one post every 2–3 min. */
const POLL_MS = 60_000;

const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Today: the time; otherwise the date. */
const short = (t: number, now: number) => new Date(t).toDateString() === new Date(now).toDateString()
  ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const rate = (perHour: number) => `${perHour >= 10 ? Math.round(perHour) : Number(perHour.toFixed(1))} / h`;

/** Admin › Instagram: the posts waiting for a worker, how many were scraped when, and when the line would be empty. */
export function InstagramSection() {
  const [range, setRange] = useState<IgRange>('24h');
  const [s, setS] = useState<InstagramStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.hidden) return;
      api.instagram().then((x) => { if (live) { setS(x); setFailed(false); setNow(Date.now()); } }, () => { if (live) setFailed(true); });
    };
    load();
    const t = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, []);

  if (failed && !s) return <div className="form-error" role="alert">Could not load the Instagram status.</div>;
  if (!s) return <p className="muted">Loading…</p>;
  if (s.source !== 'worker' || !s.queue) {
    return <p className="muted" data-testid="ig-local">The server scrapes Instagram itself (local mode): there is no worker queue to show. Its login is in Secrets &amp; keys.</p>;
  }

  const scraped = s.scraped ?? [];
  const left = inLine(s.queue);
  const f = forecast(scraped, left, now);
  const rows = buckets(scraped, range, now);
  const inRange = rows.reduce((a, r) => a + r.count, 0);
  const { label, per } = RANGES.find((x) => x.id === range)!;
  const b = burndown(scraped, left, now, range, f.endsAt);
  return (
    <>
      <div className="row-h">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((x) => <button key={x.id} className={x.id === range ? 'on' : ''} aria-pressed={x.id === range} onClick={() => setRange(x.id)}>{x.label}</button>)}
        </div>
        <span className="muted">refreshes every minute</span>
      </div>
      <div className="tiles">
        <div className="tile"><div className="k">In line</div><div className="v" data-testid="ig-in-line">{left}</div>
          <div className="s">{s.queue.leased ? `${s.queue.leased} being scraped` : 'posts and reels'}{s.queue.backingOff ? ` · ${s.queue.backingOff} retry later` : ''}</div></div>
        <div className="tile"><div className="k">Scraped</div><div className="v" data-testid="ig-scraped-total">{inRange}</div><div className="s">last {label}</div></div>
        <div className="tile"><div className="k">Pace</div><div className="v" data-testid="ig-rate">{rate(f.perHour)}</div><div className="s">average of the last 24 h</div></div>
        <div className="tile"><div className="k">Done</div>
          <div className="v">{f.endsAt === null ? '—' : left === 0 ? 'now' : short(f.endsAt, now)}</div>
          <div className="s" data-testid="ig-eta">{f.endsAt === null ? 'No estimate: nothing scraped in the last 24 h' : left === 0 ? 'Nothing in line' : `${when(f.endsAt)} · in ${duration((f.endsAt - now) / 1000)}`}</div></div>
      </div>
      <div className="charts ig-charts">
        <div className="chart-card">
          <h3><span>Scraped per {per}</span><span className="cur">{inRange}</span></h3>
          <StackedBars label={`Posts scraped per ${per}`} rows={rows.map((r) => ({ label: r.label, values: { n: r.count } }))}
            series={[{ key: 'n', label: 'Scraped', color: 'var(--series-1)' }]} format={(v) => String(Math.round(v))} />
        </div>
        <div className="chart-card">
          <h3><span>In line, and the projection</span><span className="cur">{left}</span></h3>
          <Burndown label={`Posts in line over the last ${label}${f.endsAt ? ', projected to zero' : ''}`} past={b.past} future={b.future}
            timeLabel={(t) => new Date(t).toLocaleString(undefined, range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' })} />
        </div>
      </div>
      <div className="foot"><Icon n="info_circle" size={15} /><span>
        In line = waiting, being scraped or retrying later; {s.queue.ready} scraped but not yet filed, {s.queue.failed} given up.
        The projection assumes the pace of the last 24 h (night pause included) and no new links; the past line is today's
        queue plus what was scraped since, so links that arrived meanwhile don't show.
      </span></div>
    </>
  );
}
