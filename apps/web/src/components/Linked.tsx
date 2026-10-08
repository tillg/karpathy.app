// Links in rendered note text: how a `[[wikilink]]` resolves in the open note, and text with its wikilinks as links.
import { useMemo } from 'react';
import type { RenderCtx } from '../lib/markdown';
import { resolveEmbed } from '../lib/media';
import { formatRoute } from '../lib/route';
import { parseWikilink, resolveRelativeLink, resolveWikilink, wikilinkLabel, WIKILINK_RE } from '../lib/wikilink';
import { useApp } from '../store';

/** A plain left click is handled in-app; modified clicks (new tab, window, download) go to the browser (#109). */
export const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** What rendering needs in the open note: where links point, which files exist and what embeds show. `base`: see `Markdown`. */
export function useRenderCtx(base?: string): Required<RenderCtx> {
  const { activeId, paths, note, exists } = useApp();
  const from = base ?? note?.path;
  return useMemo(() => {
    const route = (p: string) => formatRoute(activeId, p);
    return {
      exists,
      href: (target) => { const p = resolveWikilink(target, paths, from); return p ? route(p) : null; },
      relative: (href) => { const p = from !== undefined && resolveRelativeLink(href, from, paths); return p ? { path: p, href: route(p) } : null; },
      resolveEmbed: (e) => resolveEmbed(e, from || null, paths),
    };
  }, [activeId, paths, from, exists]);
}

/**
 * Text with its `[[wikilinks]]` as links, resolved like the body's (#58). `bare`: a value without
 * `[[ ]]` that names an existing note (slug or file name) links too (#108).
 */
export function Linked({ text, bare }: { text: string; bare?: boolean }) {
  const { exists, followLink } = useApp();
  const ctx = useRenderCtx();
  const out: React.ReactNode[] = [];
  let last = 0;
  const link = (key: number, inner: string) => {
    const l = parseWikilink(inner);
    out.push(
      <a key={key} href={(l.target && ctx.href(l.target)) || '#'} className={!l.target || exists(l.target) ? 'wl' : 'wl miss'} data-target={inner}
        onClick={(e) => { if (plainClick(e)) { e.preventDefault(); followLink(inner); } }}>{wikilinkLabel(l)}</a>,
    );
  };
  if (bare && !text.includes('[[') && text.trim() && exists(text.trim())) {
    link(0, text.trim());
    return <>{out}</>;
  }
  for (const m of text.matchAll(WIKILINK_RE)) {
    out.push(text.slice(last, m.index));
    link(m.index, m[1]!);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
