import { useLayoutEffect, useState } from 'react';
import { NoData, useTip } from './Tip';

const H = 200, PL = 40, PB = 22, PT = 8;
/** Narrowest gap between two day labels before every other one is dropped. */
const LABEL_GAP = 44;

export interface StackedBarsProps {
  rows: { label: string; values: Record<string, number> }[];
  /** Stack order, bottom to top; `color` is a CSS color (a `--series-N` token). */
  series: { key: string; label: string; color: string }[];
  format: (v: number) => string;
  /** Accessible name of the chart. */
  label: string;
}

/** One stack per row (day), one segment per series; hover shows the row's numbers in a tooltip. */
export function StackedBars({ rows, series, format, label }: StackedBarsProps) {
  const tip = useTip();
  // Drawn at the wrapper's real width, so the labels keep their font size on a phone instead of shrinking with a
  // scaled-down viewBox.
  const [W, setW] = useState(700);
  useLayoutEffect(() => {
    const el = tip.ref.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth) setW(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tip.ref, rows.length]);
  if (!rows.length) return <NoData />;
  const val = (r: StackedBarsProps['rows'][number], k: string) => r.values[k] ?? 0;
  const total = (r: StackedBarsProps['rows'][number]) => series.reduce((a, s) => a + val(r, s.key), 0);
  const max = Math.max(...rows.map(total)) * 1.1 || 1;
  const bw = (W - PL) / rows.length;
  const every = Math.ceil(LABEL_GAP / bw); // 1 = every day labelled; the last day always is
  const labelled = (i: number) => (rows.length - 1 - i) % every === 0;
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  return (
    <div className="chart-wrap" ref={tip.ref}>
      {series.length > 1 && (
        <div className="legend">{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
      )}
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerLeave={tip.hide}>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line x1={PL} x2={W} y1={y((max / 3) * i)} y2={y((max / 3) * i)} stroke="var(--grid)" />
            <text x={PL - 6} y={y((max / 3) * i) + 4} textAnchor="end">{format((max / 3) * i)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          let acc = 0;
          const x = PL + i * bw + bw * 0.22, w = bw * 0.56;
          return (
            <g className="stack" key={r.label}>
              {series.map((s) => {
                const y0 = y(acc), y1 = y(acc + val(r, s.key));
                acc += val(r, s.key);
                return <rect className="seg" key={s.key} x={x} y={y1} width={w} height={Math.max(0, y0 - y1)} fill={s.color} stroke="var(--bg2)" strokeWidth={1} />;
              })}
              {labelled(i) && <text x={x + w / 2} y={H - 6} textAnchor="middle">{r.label}</text>}
              <rect className="hit" x={PL + i * bw} y={0} width={bw} height={H - PB} fill="transparent"
                onPointerMove={(e) => tip.show(e, `${r.label} · ${series.map((s) => `${s.label} ${format(val(r, s.key))}`).join(' · ')}`)} />
            </g>
          );
        })}
      </svg>
      {tip.node}
      <details className="nums">
        <summary>Show numbers</summary>
        <table>
          <thead><tr><th>Day</th>{series.map((s) => <th className="num" key={s.key}>{s.label}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td>{series.map((s) => <td className="num" key={s.key}>{format(val(r, s.key))}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}
