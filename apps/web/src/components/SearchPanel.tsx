import { MAX_SEARCH_QUERY, type SearchHit } from '@karpathy/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { markedSnippet, snippet } from '../lib/snippet';
import { useApp } from '../store';
import { Icon } from './Icon';

// ~0.5em per character at the 14px snippet size (the `L12` label takes ~40px). Wider text only
// overflows the end of the row (CSS ellipsis): the centered match stays visible.
const budgetFor = (width: number) => Math.max(12, Math.floor((width - 23 - 40) / (14 * 0.5)));

/**
 * The line with the match centered in the row's width (#54), so the highlight is never cut off. The server's
 * ranges mark the matched words (#138: "Handtücher" for "handtuch"); without them the query text is marked.
 */
function highlight(raw: string, ranges: SearchHit['ranges'], q: string, budget: number) {
  const text = raw.trim();
  if (ranges?.length) {
    const lead = raw.length - raw.trimStart().length;
    const shifted = ranges.map(([a, b]) => [Math.max(0, a - lead), Math.min(text.length, b - lead)] as const);
    return <>{markedSnippet(text, shifted, budget).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}</>;
  }
  const s = snippet(text, q, budget);
  if (!s) return text;
  return <>{s.pre}<mark>{s.hit}</mark>{s.post}</>;
}

export function SearchPanel() {
  const { activeId, openNote, online, usable } = useApp();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 40)); // .hit padding
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text || !activeId || !usable) { setHits(null); return; }
    const c = new AbortController();
    const t = setTimeout(() => {
      api.search(activeId, text, c.signal).then((r) => { setHits(r.hits); setTruncated(r.truncated); setError(null); }).catch((e) => !c.signal.aborted && setError(errorText(e)));
    }, 250);
    return () => { clearTimeout(t); c.abort(); };
  }, [q, activeId, usable]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m];
  }, [hits]);

  return (
    <div className="search" ref={box}>
      <div className="sinput">
        <Icon n="search" size={18} />
        <input data-testid="search-input" type="search" placeholder={online ? 'Search vault' : 'Search needs a connection'}
          value={q} onChange={(e) => setQ(e.target.value)} disabled={!online} autoComplete="off" maxLength={MAX_SEARCH_QUERY} />
      </div>
      {error && <div className="form-error">{error}</div>}
      {hits && <div className="meta" data-testid="search-meta">{hits.length} matches · {groups.length} notes</div>}
      {hits && truncated && <div className="banner warn" data-testid="search-truncated">Showing first {hits.length} matches — refine your search</div>}
      {hits && !hits.length && <div className="empty">No results for “{q}”</div>}
      {groups.map(([path, hs]) => (
        <div key={path} className="hit">
          <button className="t" data-testid="search-result" data-path={path} onClick={() => void openNote(path, hs.find((h) => h.line)?.line)}>
            <Icon n="doc_text" size={17} />{path.split('/').pop()}
          </button>
          <div className="p">{path}</div>
          {hs.filter((h) => h.line).slice(0, 4).map((h) => (
            <button key={h.line} className="sn" onClick={() => void openNote(path, h.line)}>
              <em>L{h.line}</em>{highlight(h.text, h.ranges, q.trim(), budgetFor(width))}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
