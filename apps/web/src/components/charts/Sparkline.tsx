import { useState, type PointerEvent } from 'react';
import { NoData, useTip } from './Tip';

const W = 320, H = 84, PT = 4, PB = 16;

export interface SparklineProps {
  points: { t: number; v: number }[];
  /** Top of the y-axis (e.g. 100 for a percentage); default: the largest value plus a quarter. */
  max?: number;
  format: (v: number) => string;
  /** Accessible name of the chart. */
  label: string;
  fromLabel?: string;
  toLabel?: string;
  /** Names a point's time in the tooltip. */
  timeLabel?: (t: number) => string;
}

/** One series, drawn as a line over a faint area; hover shows a crosshair, a dot and a tooltip. */
export function Sparkline({ points, max, format, label, fromLabel, toLabel, timeLabel = String }: SparklineProps) {
  const tip = useTip();
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <NoData />;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), latest = vs[vs.length - 1]!;
  const top = max ?? (hi * 1.25 || 1);
  const x = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * W : W / 2);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / top);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const peak = vs.indexOf(hi);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - r.left) / (r.width || 1)) * (points.length - 1))));
    setHover(i);
    const b = tip.ref.current!.getBoundingClientRect();
    tip.show(e, `${format(points[i]!.v)} · ${timeLabel(points[i]!.t)}`, r.top - b.top + (y(points[i]!.v) / H) * r.height);
  };
  return (
    <div className="chart-wrap" ref={tip.ref}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => { setHover(null); tip.hide(); }}>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--grid)" />
        {max != null && <line x1={0} x2={W} y1={y(max)} y2={y(max)} stroke="var(--grid)" strokeDasharray="3 3" />}
        <path d={`${d} L${W},${y(0)} L0,${y(0)} Z`} fill="var(--series-1)" opacity={0.12} />
        <path className="line" d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        {fromLabel && <text x={0} y={H - 2}>{fromLabel}</text>}
        {toLabel && <text x={W} y={H - 2} textAnchor="end">{toLabel}</text>}
        <circle cx={x(peak)} cy={y(hi)} r={3} fill="var(--series-1)" stroke="var(--bg2)" strokeWidth={2} />
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} stroke="var(--label3)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(points[hover]!.v)} r={4} fill="var(--series-1)" stroke="var(--bg2)" strokeWidth={2} />
          </>
        )}
      </svg>
      {tip.node}
      <p className="chart-stats">min {format(lo)} · max {format(hi)} · latest {format(latest)}</p>
      <details className="nums">
        <summary>Show numbers</summary>
        <table>
          <thead><tr><th>Min</th><th>Max</th><th>Latest</th></tr></thead>
          <tbody><tr><td className="num">{format(lo)}</td><td className="num">{format(hi)}</td><td className="num">{format(latest)}</td></tr></tbody>
        </table>
      </details>
    </div>
  );
}
