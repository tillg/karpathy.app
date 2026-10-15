import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

/** A chart's hover tooltip: `wrap` goes on the positioned wrapper, `show(event, text)` / `hide()` on the pointer events. */
export function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const show = (e: PointerEvent, text: string, y?: number) => {
    const b = ref.current!.getBoundingClientRect();
    setTip({ x: e.clientX - b.left, y: y ?? e.clientY - b.top, text });
  };
  const node: ReactNode = tip && <div className="tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
  return { ref, show, hide: () => setTip(null), node };
}

export function NoData() {
  return <p className="muted chart-empty">No data yet</p>;
}
