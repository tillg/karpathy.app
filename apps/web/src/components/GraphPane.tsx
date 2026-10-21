import type { GraphData } from '@karpathy/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { localGraph, localView, shownGraph, typeColors, typeLabel, withoutTypes } from '../lib/graph';
import { useApp } from '../store';
import { Icon } from './Icon';

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
/** CSS colour tokens; the legend uses them as they are, the graph resolves them. */
const COLORS = { entity: '--tint', none: '--label3', palette: ['--graph-1', '--graph-2', '--graph-3', '--graph-4', '--graph-5', '--graph-6'] };

/** The types switched off in the legend: a per-browser preference (storage can throw: then not remembered). */
const HIDDEN_KEY = 'karpathy.graphHiddenTypes';
const loadHidden = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')); } catch { return new Set<string>(); } };
/** The local graph's depth (#92): 1 or 2 links from the open note, a per-browser preference like the types. */
const DEPTH_KEY = 'karpathy.graphDepth';
const loadDepth = () => { try { return localStorage.getItem(DEPTH_KEY) === '2' ? 2 : 1; } catch { return 1; } };

/** Room around the local graph's notes when the camera fits them, for their names (px). */
const FIT_PAD = 72;

/** Distance of the camera from a graph of one note (close enough to read its name). */
const ONE_NOTE_DISTANCE = 150;

/**
 * Fits the camera to the shown notes. One note has a bounding box of size zero, which zoomToFit answers with
 * the camera on top of the dot (invisible, or filling the screen): that one is looked at from a fixed distance.
 */
function fitCamera(g: Live['g'], ms: number, padding: number) {
  const nodes = g.graphData().nodes as { x?: number; y?: number; z?: number }[];
  if (nodes.length > 1) return void g.zoomToFit(ms, padding);
  const { x = 0, y = 0, z = 0 } = nodes[0] ?? {};
  g.cameraPosition({ x, y, z: z + ONE_NOTE_DISTANCE }, { x, y, z }, ms);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Each vault's graph, read on its first open in this session; Refresh reads it again. */
const cache = new Map<string, GraphData>();

type Node = { id: string; type?: string };
type Three = typeof import('three');
type Live = { g: import('3d-force-graph').ForceGraph3DInstance; nodes: Map<string, Node>; css: CSSStyleDeclaration; three: Three; degree: Map<string, number>; labels: Map<string, import('three').Sprite>; named: boolean; localNodes: Map<string, Node> };

/** A note's name as a sprite under its dot, for the local graph (#92), where a phone has no hover to show it. Drawn
 *  on a canvas as text, never parsed as markup. */
function nameSprite(three: Three, text: string, color: string, radius: number) {
  const name = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  const px = 48, font = `500 ${px}px -apple-system, system-ui, sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(name).width) + 8;
  c.height = Math.ceil(px * 1.3);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 4, c.height / 2);
  const map = new three.CanvasTexture(c);
  map.colorSpace = three.SRGBColorSpace;
  const sprite = new three.Sprite(new three.SpriteMaterial({ map, depthWrite: false, transparent: true }));
  const h = 7.5;
  sprite.scale.set((h * c.width) / c.height, h, 1);
  sprite.position.y = -(radius + h * 0.7);
  return sprite;
}

/**
 * 3D graph of the vault's notes and their links (#130), shown in the note pane over the open note. Built on its
 * first open and kept (only paused) while closed. Shows the open note's local graph (#92, depth 1 or 2), the `Wiki`
 * folder or all notes; a click opens the note.
 */
export function GraphPane() {
  const { activeId, note, openNote, graphOpen: open, setGraphOpen, graphScope: scope, setGraphScope, phone, admin } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ vault: string; graph: GraphData } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState(loadDepth);
  useEffect(() => { try { localStorage.setItem(DEPTH_KEY, String(depth)); } catch { /* not remembered */ } }, [depth]);
  const [drawn, setDrawn] = useState(false);
  const [hidden, setHidden] = useState(loadHidden);
  useEffect(() => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* not remembered */ } }, [hidden]);
  const toggleType = (t: string) => setHidden((h) => { const n = new Set(h); if (!n.delete(t)) n.add(t); return n; });
  const data = loaded && loaded.vault === activeId ? loaded.graph : null;
  const current = note?.path;
  // The local graph needs an open note that is in the graph; without one the scope falls back to the Wiki view.
  const center = data && current && data.nodes.some((n) => n.path === current) ? current : undefined;
  // Only the local graph follows the open note: in the Wiki and All views a note switch keeps the layout.
  const localCenter = scope === 'local' ? center : undefined;
  const local = !!localCenter;
  const all = scope === 'all';
  // `base`: the open note's neighbourhood, Wiki or all (the legend lists its types); `view`: what is drawn, without
  // the types switched off in the legend (in the local graph before its neighbourhood is taken: no islands).
  const base = useMemo(() => data && (localCenter ? localGraph(data, localCenter, depth) : shownGraph(data, all)), [data, localCenter, depth, all]);
  const view = useMemo(() => data && base && (localCenter ? localView(data, localCenter, depth, hidden) : withoutTypes(base, hidden)), [data, base, localCenter, depth, hidden]);
  const colors = useMemo(() => data && typeColors(data, COLORS), [data]);
  const live = useRef<Live | null>(null);
  /** Set when the local graph changes or is left: the camera fits the notes once the layout settles. */
  const fit = useRef(false);
  const fitSoon = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The effects below read the latest of these without rebuilding the graph.
  const latest = useRef({ view, colors, current, openNote, local });
  useLayoutEffect(() => { latest.current = { view, colors, current, openNote, local }; });

  useEffect(() => {
    if (!open || !activeId || data) return;
    const hit = cache.get(activeId);
    if (hit) { setLoaded({ vault: activeId, graph: hit }); return; }
    let gone = false;
    setError(null);
    api.graph(activeId).then((graph) => { cache.set(activeId, graph); if (!gone) setLoaded({ vault: activeId, graph }); }, (e) => !gone && setError(errorText(e)));
    return () => { gone = true; };
  }, [open, activeId, data]);

  // A note made after the graph was read (by the AI, a pull, another device) is not in it: then the graph is read
  // again, once per note, so the local graph can centre on it.
  const reread = useRef<string | null>(null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  useEffect(() => {
    if (!open || !activeId || !data || !current || center || !/\.md$/i.test(current)) return;
    const key = `${activeId}\n${current}`;
    if (reread.current === key) return;
    reread.current = key;
    api.graph(activeId).then((graph) => {
      cache.set(activeId, graph);
      if (activeRef.current === activeId) setLoaded({ vault: activeId, graph });
    }, () => { /* the graph read before stays */ });
  }, [open, activeId, data, current, center]);

  useEffect(() => {
    const el = host.current;
    if (!data || !el) return;
    let gone = false;
    const ro = new ResizeObserver(() => live.current?.g.width(el.clientWidth).height(el.clientHeight));
    void Promise.all([import('3d-force-graph'), import('three')]).then(([{ default: ForceGraph3D }, three]) => {
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
        .onEngineStop(() => { if (fit.current) { fit.current = false; fitCamera(g, 400, latest.current.local ? FIT_PAD : 20); } })
        .onNodeClick((n) => void latest.current.openNote(String(n.id)));
      // The same node objects for every view keep the layout when the scope changes.
      live.current = { g, css, three, degree, labels: new Map(), named: false, localNodes: new Map(), nodes: new Map(data.nodes.map((n) => [n.path, { id: n.path, type: n.type }])) };
      show();
      paint();
      ro.observe(el);
    });
    return () => {
      gone = true;
      ro.disconnect();
      fitSoon.current.forEach(clearTimeout);
      for (const s of live.current?.labels.values() ?? []) { s.material.map?.dispose(); s.material.dispose(); }
      live.current?.g._destructor();
      live.current = null;
      el.replaceChildren();
      setDrawn(false);
    };
  }, [data]);

  /** Hands the shown notes and links to the graph; the local graph names its notes and fits the camera to them. */
  const show = () => {
    const l = live.current, { view: v, local: loc } = latest.current;
    if (!l || !v) return;
    const label = (n: object) => {
      const id = String((n as Node).id);
      let s = l.labels.get(id);
      if (!s) l.labels.set(id, (s = nameSprite(l.three, title(id), l.css.getPropertyValue('--label').trim(), 4 * Math.cbrt(1 + (l.degree.get(id) ?? 0)))));
      return s;
    };
    const mode = l.named !== loc;
    // The local graph lies flat (2D), on its own node objects, so the vault's 3D layout survives the visit.
    if (mode && !loc) l.g.numDimensions(3);
    // A new accessor rebuilds every dot: only when the names come or go.
    if (mode) l.g.nodeThreeObjectExtend(true).nodeThreeObject(loc ? label : () => null as unknown as import('three').Object3D);
    l.named = loc;
    const nodes = loc ? l.localNodes : l.nodes;
    const node = (n: GraphData['nodes'][number]) => {
      let o = nodes.get(n.path);
      if (!o) nodes.set(n.path, (o = { id: n.path, type: n.type }));
      return o;
    };
    l.g.graphData({ nodes: v.nodes.map(node), links: v.links.map((x) => ({ ...x })) });
    if (mode) {
      // Flat: one finger (left button) moves instead of rotating, and the camera faces the plane.
      const c = l.g.controls() as { mouseButtons: { LEFT: number }; touches: { ONE: number } };
      c.mouseButtons.LEFT = loc ? l.three.MOUSE.PAN : l.three.MOUSE.ROTATE;
      c.touches.ONE = loc ? l.three.TOUCH.PAN : l.three.TOUCH.ROTATE;
      // The few notes settle in about 2 s instead of 5.
      l.g.d3AlphaDecay(loc ? 0.05 : 0.0228);
      if (loc) l.g.numDimensions(2).cameraPosition({ x: 0, y: 0, z: 300 }, { x: 0, y: 0, z: 0 });
      // More room between the notes for their names (numDimensions resets the charge: -30 flat, -60 in 3D).
      if (loc) (l.g.d3Force('charge') as unknown as { strength(s: number): void } | undefined)?.strength(-120);
      (l.g.d3Force('link') as unknown as { distance(d: number): void } | undefined)?.distance(loc ? 40 : 30);
    }
    fit.current = loc || mode;
    fitSoon.current.forEach(clearTimeout);
    // The local graph: once early, when the layout has roughly settled, and again when it stops (onEngineStop).
    // Back from it: the camera finds the vault's layout again, now and when it stops.
    if (loc) fitSoon.current = [600, 1500, 3000].map((ms) => setTimeout(() => { if (latest.current.local && live.current) fitCamera(live.current.g, 400, FIT_PAD); }, ms));
    else if (mode) fitSoon.current = [300, 1500].map((ms) => setTimeout(() => { if (live.current) fitCamera(live.current.g, 400, 20); }, ms));
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
  // Not while admin mode covers it (the graph stays mounted underneath).
  useEffect(() => {
    if (!open || admin !== null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]')) setGraphOpen(false);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [open, admin, setGraphOpen]);

  const refresh = () => { if (activeId) cache.delete(activeId); setLoaded(null); };
  const hasWiki = !!data && shownGraph(data, false) !== data;
  const wikiOnly = !local && scope !== 'all' && hasWiki;
  const scopes = ([['local', 'Local', !!center], ['wiki', 'Wiki', hasWiki], ['all', 'All', true]] as const).filter(([, , on]) => on);
  const shown = local ? 'local' : scope === 'all' || !hasWiki ? 'all' : 'wiki';
  const shownTypes = useMemo(() => new Set(base?.nodes.map((n) => typeLabel(n.type))), [base]);

  return (
    <section className="graph-pane" hidden={!open} data-testid="graph-pane" aria-label="Graph">
      <header className="bar">
        <button className={`ib${phone ? ' back' : ''}`} title="Close graph" aria-label="Close graph" data-testid="graph-close" onClick={() => setGraphOpen(false)}>
          {phone ? <><Icon n="chevron_left" size={24} /><span>Back</span></> : <Icon n="xmark" />}
        </button>
        <span className="bar-title">Graph</span>
        <span className="sp" />
        {data && scopes.length > 1 && (
          <div className="seg" role="group" aria-label="Notes shown">
            {scopes.map(([s, label]) => (
              <button key={s} className={shown === s ? 'on' : ''} aria-pressed={shown === s} data-testid={`graph-${s}`} onClick={() => setGraphScope(s)}>{label}</button>
            ))}
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
            {local && (
              <div className="graph-depth">
                <span id="graph-depth-label">Depth</span>
                <div className="seg" role="group" aria-labelledby="graph-depth-label">
                  {[1, 2].map((d) => <button key={d} className={depth === d ? 'on' : ''} aria-pressed={depth === d} data-testid={`graph-depth-${d}`} onClick={() => setDepth(d)}>{d}</button>)}
                </div>
              </div>
            )}
            {local && view && (
              // The canvas can't be reached by keyboard or screen reader: the same notes as buttons.
              <ul className="sr-only" aria-label="Notes in the graph">
                {view.nodes.map((n) => <li key={n.path}><button data-testid="graph-note" onClick={() => void openNote(n.path)}>{title(n.path)}</button></li>)}
              </ul>
            )}
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
            <p>{view
              ? `${plural(view.nodes.length, 'note')}${local ? ` within ${depth} ${depth === 1 ? 'link' : 'links'} of ${title(center!)}` : wikiOnly ? ' in Wiki' : ''} · ${plural(view.links.length, 'link')} · ${local ? 'drag to move' : 'drag to rotate'}, pinch or scroll to zoom, tap a note to open it`
              : 'Loading…'}</p>
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
