import type { GraphData } from '@karpathy/shared';

const inWiki = (path: string) => /^wiki\//i.test(path);

/** What the graph shows: the notes in the vault's `Wiki` folder and the links between them, or everything when
 *  `all` is set or the vault has no `Wiki` folder. */
export function shownGraph(data: GraphData, all: boolean): GraphData {
  if (all || !data.nodes.some((n) => inWiki(n.path))) return data;
  return { nodes: data.nodes.filter((n) => inWiki(n.path)), links: data.links.filter((l) => inWiki(l.source) && inWiki(l.target)) };
}

/** One colour per note type: `entity` and untyped notes have their own, the other types take the palette in name order. */
export function typeColors(data: GraphData, c: { entity: string; none: string; palette: string[] }) {
  const types = [...new Set(data.nodes.map((n) => n.type).filter((t): t is string => !!t && t !== 'entity'))].sort();
  const color = new Map(types.map((t, i) => [t, c.palette[i % c.palette.length]!]));
  return {
    of: (type: string | undefined) => (type === 'entity' ? c.entity : (type && color.get(type)) || c.none),
    legend: [...color],
  };
}

/** A note's type as the legend names it. */
export const typeLabel = (type: string | undefined) => type || 'no type';

/** The graph without the notes of the `hidden` types (legend labels) and their links. */
export function withoutTypes(data: GraphData, hidden: ReadonlySet<string>): GraphData {
  if (!hidden.size) return data;
  const nodes = data.nodes.filter((n) => !hidden.has(typeLabel(n.type)));
  const keep = new Set(nodes.map((n) => n.path));
  return { nodes, links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
}
