import { useLayoutEffect, useState } from 'react';
import { NoData, useTip } from './Tip';

const H = 180, PL = 40, PR = 8, PB = 22, PT = 8;

export interface BurndownProps {
  /** What was in line over time, oldest first; the last point is now. */
  past: { t: number; v: number }[];
  /** The projection, from now down to zero; empty without one. */
  future: { t: number; v: number }[];
  label: string;
  timeLabel: (t: number) => string;
}

/** A line over time: solid for the past, dashed for the projection; x is time, so the projection keeps its scale. */
export function Burndown({ past, future, label, timeLabel }: BurndownProps) {
  const tip = useTip();
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
  }, [tip.ref]);
  if (!past.length) return <NoData />;
  const all = [...past, ...future];
  const t0 = past[0]!.t, t1 = Math.max(...all.map((p) => p.t));
  const max = Math.max(...all.map((p) => p.v)) * 1.1 || 1;
  const x = (t: number) => PL + (W - PL - PR) * (t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const path = (ps: { t: number; v: number }[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const now = past[past.length - 1]!;
  const end = future[future.length - 1];
  return (
    <div className="chart-wrap" ref={tip.ref}>
      <div className="legend">
        <span><i style={{ background: 'var(--series-1)' }} />In line</span>
        {end && <span><i style={{ background: 'var(--series-2)' }} />At the current pace</span>}
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerLeave={tip.hide}>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y((max / 3) * i)} y2={y((max / 3) * i)} stroke="var(--grid)" />
            <text x={PL - 6} y={y((max / 3) * i) + 4} textAnchor="end">{Math.round((max / 3) * i)}</text>
          </g>
        ))}
        <path d={path(past)} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        {end && <path d={path(future)} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="5 4" />}
        <line x1={x(now.t)} x2={x(now.t)} y1={PT} y2={H - PB} stroke="var(--grid)" strokeDasharray="2 3" />
        <text x={PL} y={H - 6} textAnchor="start">{timeLabel(t0)}</text>
        <text x={x(now.t)} y={H - 6} textAnchor={end ? 'middle' : 'end'}>now</text>
        {end && x(end.t) - x(now.t) > 70 && <text x={W - PR} y={H - 6} textAnchor="end">{timeLabel(end.t)}</text>}
        <rect x={PL} y={0} width={W - PL - PR} height={H - PB} fill="transparent"
          onPointerMove={(e) => {
            const b = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
            const t = t0 + ((e.clientX - b.left) * (W / b.width) - PL) / (W - PL - PR) * (t1 - t0);
            if (t <= now.t) {
              const p = past.reduce((a, q) => (Math.abs(q.t - t) < Math.abs(a.t - t) ? q : a));
              tip.show(e, `${timeLabel(p.t)} · ${p.v} in line`);
            } else if (end) {
              const v = Math.max(0, Math.round(now.v * (1 - (t - now.t) / (end.t - now.t))));
              tip.show(e, `${timeLabel(t)} · ~${v} in line`);
            }
          }} />
      </svg>
      {tip.node}
    </div>
  );
}
