import type { MetricsReport, MetricsSample } from '@karpathy/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { percent, pct } from '../lib/percent';
import { Sparkline } from './charts/Sparkline';
import { Icon } from './Icon';

type Range = '1h' | '24h' | '7d';
const RANGES: { id: Range; label: string; ago: string }[] = [
  { id: '1h', label: '1 hour', ago: '1 h ago' },
  { id: '24h', label: '24 hours', ago: '24 h ago' },
  { id: '7d', label: '7 days', ago: '7 d ago' },
];
/** Used until the first report says how often the backend samples. */
const DEFAULT_INTERVAL_S = 30;
const gb = (b: number) => (b / 1024 ** 3).toFixed(1).replace(/\.0$/, '');
/** Share of the vaults disk in use, in whole percent. */
export const diskPercent = (s: MetricsSample) => percent(s.vaultsUsed, s.vaultsTotal);
const usage = (used: number, total: number) => `${gb(used)} / ${gb(total)} GB`;
/** 27660 → "7 h 41 min"; under an hour "12 min"; from a day "2 d 3 h". */
export const duration = (s: number) => {
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d} d ${h % 24} h` : h ? `${h} h ${m % 60} min` : `${m} min`;
};

interface Metric { title: string; sub: string; max?: (s: MetricsSample) => number; value: (s: MetricsSample) => number; format: (v: number, s: MetricsSample) => string }
const METRICS: Metric[] = [
  { title: 'CPU', sub: 'Share of all cores in use', max: () => 100, value: (s) => s.cpu, format: (v) => `${Math.round(v)} %` },
  { title: 'Memory', sub: 'In use of the total', max: (s) => s.memTotal, value: (s) => s.memUsed, format: (v, s) => `${gb(v)} / ${gb(s.memTotal)} GB` },
  { title: 'Load', sub: '1-minute average', value: (s) => s.load1, format: (v) => v.toFixed(2) },
  { title: 'Disk · vaults', sub: 'Vault clones', max: (s) => s.vaultsTotal, value: (s) => s.vaultsUsed, format: (v, s) => `${usage(v, s.vaultsTotal)} · ${pct(v, s.vaultsTotal)}` },
  { title: 'Disk · config', sub: 'Config volume', max: (s) => s.configTotal, value: (s) => s.configUsed, format: (v, s) => `${usage(v, s.configTotal)} · ${pct(v, s.configTotal)}` },
];

/** "updated N s ago": ticks on its own, so the charts do not re-render every second. */
function Updated({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <> · updated {Math.max(0, Math.round((now - at) / 1000))} s ago</>;
}

/** Server (#150): CPU, memory, load and disk of the machine the backend runs on, polled at the sampling interval while shown and visible. */
export function ServerSection() {
  const [range, setRange] = useState<Range>('24h');
  const [r, setR] = useState<MetricsReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(0);
  /** The current range's liveness: switched off on a range change and on unmount, so an answer for an older range is dropped. */
  const cur = useRef({ live: false });
  const load = useCallback(() => {
    const mine = cur.current;
    return api.metrics(range).then((x) => { if (mine.live) { setR(x); setFailed(false); setFetchedAt(Date.now()); } }, () => { if (mine.live) setFailed(true); });
  }, [range]);
  useEffect(() => {
    const mine = { live: true };
    cur.current = mine;
    setR(null);
    setFailed(false);
    void load();
    return () => { mine.live = false; };
  }, [load]);
  const intervalS = r?.intervalS ?? DEFAULT_INTERVAL_S;
  // Poll only while the page is visible; coming back to it refetches.
  useEffect(() => {
    const poll = () => { if (!document.hidden) void load(); };
    const t = setInterval(poll, intervalS * 1000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', poll); };
  }, [load, intervalS]);

  const { ago } = RANGES.find((x) => x.id === range)!;
  const latest = r?.latest ?? null;
  return (
    <>
      <div className="row-h">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((x) => <button key={x.id} className={x.id === range ? 'on' : ''} aria-pressed={x.id === range} onClick={() => setRange(x.id)}>{x.label}</button>)}
        </div>
        <span className="muted">sampled every {intervalS} s{fetchedAt ? <Updated key={fetchedAt} at={fetchedAt} /> : null}</span>
      </div>
      {failed && <div className="form-error" role="alert">Could not load the server metrics.</div>}
      {!r && !failed && <p className="muted">Loading server metrics…</p>}
      {r && (
        <>
          <div className="srv-list">
            <div className="srv-li">
              <Icon n="bolt_horizontal" size={20} /><span className="tx"><b>AI harness (opencode)</b></span>
              {latest && <span className={`status ${latest.opencodeUp ? 'ok' : 'warn'}`}><Icon n={latest.opencodeUp ? 'checkmark_alt' : 'exclamationmark_triangle'} size={14} />{latest.opencodeUp ? 'Up' : 'Down'}</span>}
            </div>
            <div className="srv-li">
              <Icon n="timer" size={20} /><span className="tx"><b>Backend uptime</b></span>
              <span className="muted">{duration(r.uptimeS)}</span>
            </div>
          </div>
          {latest ? (
            <div className="charts">
              {METRICS.map((m) => (
                <div className="chart-card" key={m.title}>
                  <h3><span>{m.title}</span><span className="cur">{m.format(m.value(latest), latest)}</span></h3>
                  <div className="sub">{m.sub}</div>
                  <Sparkline
                    label={m.title}
                    points={r.samples.map((s) => ({ t: s.at, v: m.value(s) }))}
                    max={m.max?.(latest)}
                    format={(v) => m.format(v, latest)}
                    fromLabel={ago}
                    toLabel="now"
                    timeLabel={(t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  />
                </div>
              ))}
            </div>
          ) : <p className="muted">No data yet — the first sample comes within {intervalS} s.</p>}
          <div className="foot"><Icon n="info_circle" size={15} /><span>The machine the backend runs on. Alerts (disk, memory, down) still go to your phone via ntfy.</span></div>
        </>
      )}
    </>
  );
}
