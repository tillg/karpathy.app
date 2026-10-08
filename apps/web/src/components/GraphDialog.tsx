import type { GraphData } from '@karpathy/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './Dialogs';

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

/** 3D graph of the vault's notes and their links (#130); a click on a note opens it. three.js loads on first open. */
export function GraphDialog({ onClose }: { onClose(): void }) {
  const { activeId, note, openNote } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = note?.path;
  // Callers pass fresh callbacks on every render: keep them out of the effect, or the graph would be rebuilt each time.
  const act = useRef({ onClose, openNote });
  useLayoutEffect(() => { act.current = { onClose, openNote }; });

  useEffect(() => {
    if (!activeId) return;
    let gone = false;
    api.graph(activeId).then((d) => !gone && setData(d), (e) => !gone && setError(errorText(e)));
    return () => { gone = true; };
  }, [activeId]);

  useEffect(() => {
    const el = host.current;
    if (!data || !el) return;
    let gone = false;
    let graph: { _destructor(): void } | undefined;
    let resize: (() => void) | undefined;
    const ro = new ResizeObserver(() => resize?.());
    void import('3d-force-graph').then(({ default: ForceGraph3D }) => {
      if (gone) return;
      const css = getComputedStyle(el);
      const color = (v: string) => css.getPropertyValue(v).trim();
      const degree = new Map<string, number>();
      for (const l of data.links) for (const p of [l.source, l.target]) degree.set(p, (degree.get(p) ?? 0) + 1);
      const g = new ForceGraph3D(el, { controlType: 'orbit' })
        .width(el.clientWidth).height(el.clientHeight)
        .backgroundColor(color('--paper'))
        .showNavInfo(false)
        .graphData({ nodes: data.nodes.map((n) => ({ id: n.path })), links: data.links.map((l) => ({ ...l })) })
        // An element, not an HTML string: note names are never parsed as markup.
        .nodeLabel((n) => Object.assign(document.createElement('span'), { textContent: title(String(n.id)) }))
        .nodeVal((n) => 1 + (degree.get(String(n.id)) ?? 0))
        .nodeColor((n) => (n.id === current ? color('--orange') : color('--tint')))
        .nodeOpacity(0.9)
        .linkColor(() => color('--label3'))
        .linkOpacity(0.35)
        .onNodeClick((n) => { act.current.onClose(); void act.current.openNote(String(n.id)); });
      graph = g;
      resize = () => g.width(el.clientWidth).height(el.clientHeight);
      ro.observe(el);
    });
    return () => { gone = true; ro.disconnect(); graph?._destructor(); el.replaceChildren(); };
  }, [data, current]);

  return (
    <Modal title="Graph" onClose={onClose} className="graph" testid="graph-dialog" focusTitle>
      {error ? <div className="form-error" role="alert">{error}</div> : (
        <>
          <div ref={host} className="graph-host" data-testid="graph" data-nodes={data?.nodes.length} data-links={data?.links.length} />
          <p className="graph-hint">{data ? `${data.nodes.length} notes · ${data.links.length} links · drag to rotate, pinch or scroll to zoom, tap a note to open it` : 'Loading…'}</p>
        </>
      )}
    </Modal>
  );
}
