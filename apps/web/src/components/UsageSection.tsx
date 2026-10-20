import type { UsageReport } from '@karpathy/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { shortNumber } from '../lib/chat';
import { pct } from '../lib/percent';
import { StackedBars } from './charts/StackedBars';
import { Icon } from './Icon';

type Sums = UsageReport['total'];
const RANGES = [7, 30] as const;
/** All tokens of a report row, cache included. */
export const tokens = (s: Sums) => s.input + s.output + s.reasoning + s.cacheRead + s.cacheWrite;
const cache = (s: Sums) => s.cacheRead + s.cacheWrite;
/** Reasoning tokens are billed as output, so they count there. */
const out = (s: Sums) => s.output + s.reasoning;
export const money = (x: number) => `$${x.toFixed(2)}`;
/** "2026-10-09" → "Oct 9" in the browser locale (parsed as a local date: no timezone shift). */
const dayLabel = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Usage (#150): tokens and cost by day, model and vault, from the chats that still exist. */
export function UsageSection() {
  const [days, setDays] = useState<7 | 30>(7);
  const [r, setR] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setR(null);
    setFailed(false);
    api.usage(days).then((x) => live && setR(x), () => live && setFailed(true));
    return () => { live = false; };
  }, [days]);

  const total = r ? tokens(r.total) : 0;
  const first = r?.days[0]?.date, last = r?.days.at(-1)?.date;
  return (
    <>
      <div className="row-h">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((n) => <button key={n} className={n === days ? 'on' : ''} aria-pressed={n === days} onClick={() => setDays(n)}>{n} days</button>)}
        </div>
        {first && last && <span className="muted">{dayLabel(first)} – {dayLabel(last)}</span>}
      </div>
      {failed && <div className="form-error" role="alert">Could not load the usage.</div>}
      {!r && !failed && <p className="muted">Loading usage…</p>}
      {r && (
        <>
          <div className="tiles">
            <div className="tile"><div className="k">Total tokens</div><div className="v">{shortNumber(total)}</div><div className="s">{days} days</div></div>
            <div className="tile"><div className="k">Input</div><div className="v">{shortNumber(r.total.input)}</div><div className="s">{pct(r.total.input, total)}</div></div>
            <div className="tile"><div className="k">Output</div><div className="v">{shortNumber(out(r.total))}</div><div className="s">{pct(out(r.total), total)}</div></div>
            {r.costKnown && <div className="tile"><div className="k">Cost</div><div className="v">{money(r.total.cost)}</div><div className="s">as reported by the provider</div></div>}
          </div>
          <div className="gh">Tokens per day</div>
          <div className="chart-card">
            <StackedBars
              label="Tokens per day"
              format={shortNumber}
              series={[
                { key: 'input', label: 'Input', color: 'var(--series-1)' },
                { key: 'cache', label: 'Cache', color: 'var(--series-3)' },
                { key: 'output', label: 'Output', color: 'var(--series-2)' },
              ]}
              rows={r.days.map((d) => ({ label: dayLabel(d.date), values: { input: d.input, cache: cache(d), output: out(d) } }))}
            />
          </div>
          <div className="gh">By model</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Model</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache</th>{r.costKnown && <th className="num">Cost</th>}</tr></thead>
              <tbody>
                {r.byModel.map((m) => (
                  <tr key={m.model}>
                    <td className="mono">{m.model}</td><td className="num">{shortNumber(m.input)}</td><td className="num">{shortNumber(out(m))}</td><td className="num">{cache(m) ? shortNumber(cache(m)) : '—'}</td>
                    {r.costKnown && <td className="num">{money(m.cost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="gh">By vault</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Vault</th><th className="num">Chats</th><th className="num">Tokens</th>{r.costKnown && <th className="num">Cost</th>}</tr></thead>
              <tbody>
                {r.byVault.map((v) => (
                  <tr key={v.vault}>
                    <td>{v.name}</td><td className="num">{v.chats}</td><td className="num">{shortNumber(tokens(v))}</td>
                    {r.costKnown && <td className="num">{money(v.cost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="foot"><Icon n="info_circle" size={15} /><span>Counts the chats that still exist. A deleted chat drops out; cost as reported by the provider.</span></div>
        </>
      )}
    </>
  );
}
