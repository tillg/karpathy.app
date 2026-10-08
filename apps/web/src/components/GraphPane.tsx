import type { GraphData } from '@karpathy/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { shownGraph, typeColors, typeLabel, withoutTypes } from '../lib/graph';
import { useApp } from '../store';
import { Icon } from './Icon';

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
/** CSS colour tokens; the legend uses them as they are, the graph resolves them. */
const COLORS = { entity: '--tint', none: '--label3', palette: ['--graph-1', '--graph-2', '--graph-3', '--graph-4', '--graph-5', '--graph-6'] };

/** The types switched off in the legend: a per-browser preference (storage can throw: then not remembered). */
const HIDDEN_KEY = 'karpathy.graphHiddenTypes';
const loadHidden = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')); } catch { return new Set<string>(); } };

/** Each vault's graph, read on its first open in this session; Refresh reads it again. */
const cache = new Map<string, GraphData>();

type Node = { id: string; type?: string };
type Live = { g: import('3d-force-graph').ForceGraph3DInstance; nodes: Map<string, Node>; css: CSSStyleDeclaration };

/**
 * 3D graph of the vault's notes and their links (#130), shown in the note pane over the open note. Built on its
 * first open and kept (only paused) while closed. Shows the `Wiki` folder unless "Show all"; a click opens the note.
 */
export function GraphPane() {
  const { activeId, note, openNote, graphOpen: open, setGraphOpen, phone } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ vault: string; graph: GraphData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [hidden, setHidden] = useState(loadHidden);
  useEffect(() => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* not remembered */ } }, [hidden]);
  const toggleType = (t: string) => setHidden((h) => { const n = new Set(h); if (!n.delete(t)) n.add(t); return n; });
  const data = loaded && loaded.vault === activeId ? loaded.graph : null;
  // `base`: Wiki or all; `view`: without the types switched off in the legend.
  const base = useMemo(() => data && shownGraph(data, all), [data, all]);
  const view = useMemo(() => base && withoutTypes(base, hidden), [base, hidden]);
  const colors = useMemo(() => data && typeColors(data, COLORS), [data]);
  const current = note?.path;
  const live = useRef<Live | null>(null);
  // The effects below read the latest of these without rebuilding the graph.
  const latest = useRef({ view, colors, current, openNote });
  useLayoutEffect(() => { latest.current = { view, colors, current, openNote }; });

  useEffect(() => {
    if (!open || !activeId || data) return;
    const hit = cache.get(activeId);
    if (hit) { setLoaded({ vault: activeId, graph: hit }); return; }
    let gone = false;
    setError(null);
    api.graph(activeId).then((graph) => { cache.set(activeId, graph); if (!gone) setLoaded({ vault: activeId, graph }); }, (e) => !gone && setError(errorText(e)));
    return () => { gone = true; };
  }, [open, activeId, data]);

  useEffect(() => {
    const el = host.current;
    if (!data || !el) return;
    let gone = false;
    const ro = new ResizeObserver(() => live.current?.g.width(el.clientWidth).height(el.clientHeight));
    void import('3d-force-graph').then(({ default: ForceGraph3D }) => {
      if (gone) return;
      const css = getComputedStyle(el);
      const degree = new Map<string, number>();
      for (const l of data.links) for (const p of [l.source, l.target]) degree.set(p, (degree.get(p) ?? 0) + 1);
      const g = new ForceGraph3D(el, { controlType: 'orbit' })
        .width(el.clientWidth).height(el.clientHeight)
        .backgroundColor(css.getPropertyValue('--paper').trim())
        .showNavInfo(false)
        // An element, not an HTML string: note names are never parsed as markup.
        .nodeLabel((n) => Object.assign(document.createElement('span'), { textContent: title(String(n.id)) }))
        .nodeVal((n) => 1 + (degree.get(String(n.id)) ?? 0))
        .nodeOpacity(0.9)
        .linkColor(() => css.getPropertyValue('--label3').trim())
        .linkOpacity(0.35)
        .onEngineTick(() => setDrawn(true))
        .onNodeClick((n) => void latest.current.openNote(String(n.id)));
      // The same node objects for every view keep the layout when "Show all" is toggled.
      live.current = { g, css, nodes: new Map(data.nodes.map((n) => [n.path, { id: n.path, type: n.type }])) };
      show();
      paint();
      ro.observe(el);
    });
    return () => { gone = true; ro.disconnect(); live.current?.g._destructor(); live.current = null; el.replaceChildren(); setDrawn(false); };
  }, [data]);

  /** Hands the shown notes and links to the graph. */
  const show = () => {
    const l = live.current, v = latest.current.view;
    if (l && v) l.g.graphData({ nodes: v.nodes.map((n) => l.nodes.get(n.path)!), links: v.links.map((x) => ({ ...x })) });
  };
  /** Colours the notes: the open one orange, the others by type. */
  const paint = () => {
    const l = live.current, { colors: c, current: cur } = latest.current;
    const color = (v: string) => l!.css.getPropertyValue(v).trim();
    l?.g.nodeColor((n) => (n.id === cur ? color('--orange') : color(c!.of((n as Node).type))));
  };
  useEffect(show, [view]);
  useEffect(paint, [current]);
  useEffect(() => { if (open) live.current?.g.resumeAnimation(); else live.current?.g.pauseAnimation(); }, [open, drawn]);

  // Escape closes the graph, unless a dialog is open over it.
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) setGraphOpen(false);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, setGraphOpen]);

  const refresh = () => { if (activeId) cache.delete(activeId); setLoaded(null); };
  const wikiOnly = !!data && base !== data;
  const shownTypes = useMemo(() => new Set(base?.nodes.map((n) => typeLabel(n.type))), [base]);

  return (
    <section className="graph-pane" hidden={!open} data-testid="graph-pane" aria-label="Graph">
      <header className="bar">
        <button className={`ib${phone ? ' back' : ''}`} title="Close graph" aria-label="Close graph" data-testid="graph-close" onClick={() => setGraphOpen(false)}>
          {phone ? <><Icon n="chevron_left" size={24} /><span>Back</span></> : <Icon n="xmark" />}
        </button>
        <span className="bar-title">Graph</span>
        <span className="sp" />
        {data && (wikiOnly || all) && (
          <div className="seg" role="group" aria-label="Notes shown">
            <button className={all ? '' : 'on'} aria-pressed={!all} data-testid="graph-wiki" onClick={() => setAll(false)}>Wiki</button>
            <button className={all ? 'on' : ''} aria-pressed={all} data-testid="graph-all" onClick={() => setAll(true)}>Show all</button>
          </div>
        )}
        <button className="ib" title="Refresh graph" aria-label="Refresh graph" data-testid="graph-refresh" disabled={!data} onClick={refresh}><Icon n="arrow_clockwise" /></button>
      </header>
      {error ? <div className="form-error" role="alert">{error}</div> : (
        <>
          <div className="graph-stage">
            <div ref={host} className="graph-host" data-testid="graph" data-nodes={view?.nodes.length} data-links={view?.links.length} />
            {!drawn && (
              <div className="graph-loading" data-testid="graph-loading" role="status">
                <BreathingGraph />
                <p>{view ? `Laying out ${view.nodes.length} notes…` : 'Reading the notes…'}</p>
              </div>
            )}
          </div>
          <div className="graph-hint">
            {view && colors && (
              <ul className="graph-legend" data-testid="graph-legend">
                {[['entity', COLORS.entity], ...colors.legend, [typeLabel(undefined), COLORS.none]].filter(([t]) => shownTypes.has(t!)).map(([t, v]) => (
                  <li key={t}>
                    <label>
                      <input type="checkbox" checked={!hidden.has(t!)} onChange={() => toggleType(t!)} style={{ accentColor: `var(${v})` }} data-testid={`graph-type-${t}`} />
                      {t}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p>{view ? `${view.nodes.length} notes${wikiOnly ? ' in Wiki' : ''} · ${view.links.length} links · drag to rotate, pinch or scroll to zoom, tap a note to open it` : 'Loading…'}</p>
          </div>
        </>
      )}
    </section>
  );
}

/** The loading loop: a small graph that breathes (CSS only, still under reduced motion). */
function BreathingGraph() {
  const dots: [number, number, number][] = [[50, 50, 7], [22, 30, 5], [80, 26, 5], [84, 70, 4.5], [30, 78, 5.5], [56, 14, 3.5], [12, 58, 3.5]];
  const lines = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [2, 5], [4, 6], [1, 6], [3, 2]];
  return (
    <svg className="breathing" viewBox="0 0 100 100" aria-hidden>
      {lines.map(([a, b]) => <line key={`${a}-${b}`} x1={dots[a!]![0]} y1={dots[a!]![1]} x2={dots[b!]![0]} y2={dots[b!]![1]} />)}
      {dots.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} style={{ animationDelay: `${i * -0.35}s` }} />)}
    </svg>
  );
}
