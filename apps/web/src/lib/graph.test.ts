import { expect, it } from 'vitest';
import { localGraph, shownGraph, typeColors, withoutTypes } from './graph';

const data = {
  nodes: [{ path: 'Home.md' }, { path: 'Wiki/a.md', type: 'entity' }, { path: 'wiki/b.md', type: 'topic' }, { path: 'Wiki/c.md', type: 'concept' }],
  links: [{ source: 'Home.md', target: 'Wiki/a.md' }, { source: 'Wiki/a.md', target: 'wiki/b.md' }],
};

it('shows only the Wiki folder (any case) unless all is asked for', () => {
  expect(shownGraph(data, false)).toEqual({ nodes: data.nodes.slice(1), links: [data.links[1]] });
  expect(shownGraph(data, true)).toBe(data);
});

it('shows everything when the vault has no Wiki folder', () => {
  const flat = { nodes: [{ path: 'a.md' }, { path: 'Wikipedia.md' }], links: [] };
  expect(shownGraph(flat, false)).toBe(flat);
});

it('gives entity and untyped notes their own colours and every other type one of the palette, by name', () => {
  const c = typeColors(data, { entity: 'E', none: 'N', palette: ['p0', 'p1'] });
  expect(c.legend).toEqual([['concept', 'p0'], ['topic', 'p1']]);
  expect([c.of('entity'), c.of(undefined), c.of('concept'), c.of('topic')]).toEqual(['E', 'N', 'p0', 'p1']);
  const more = typeColors({ nodes: [...data.nodes, { path: 'x.md', type: 'zz' }], links: [] }, { entity: 'E', none: 'N', palette: ['p0', 'p1'] });
  expect(more.of('zz')).toBe('p0');
});

it('drops the hidden types (untyped = "no type") and their links', () => {
  expect(withoutTypes(data, new Set(['topic', 'no type']))).toEqual({ nodes: [data.nodes[1], data.nodes[3]], links: [] });
  expect(withoutTypes(data, new Set())).toBe(data);
});

// #92: the local graph of the open note.
const web = {
  nodes: ['c.md', 'a.md', 'b.md', 'x.md', 'y.md', 'far.md', 'lone.md'].map((path) => ({ path })),
  links: [
    { source: 'c.md', target: 'a.md' }, // outgoing
    { source: 'b.md', target: 'c.md' }, // backlink
    { source: 'a.md', target: 'b.md' }, // between two neighbours
    { source: 'a.md', target: 'x.md' }, // depth 2 via an outgoing link
    { source: 'y.md', target: 'b.md' }, // depth 2 via a backlink
    { source: 'x.md', target: 'far.md' }, // depth 3
  ],
};
const paths = (g: { nodes: { path: string }[] }) => g.nodes.map((n) => n.path).sort();

it('keeps the notes within the depth of the centre, following links and backlinks, and the links between them', () => {
  const one = localGraph(web, 'c.md', 1);
  expect(paths(one)).toEqual(['a.md', 'b.md', 'c.md']);
  expect(one.links).toEqual(web.links.slice(0, 3));
  const two = localGraph(web, 'c.md', 2);
  expect(paths(two)).toEqual(['a.md', 'b.md', 'c.md', 'x.md', 'y.md']);
  expect(two.links).toEqual(web.links.slice(0, 5));
});

it('shows a note without links alone, and nothing for a note that is not in the graph', () => {
  expect(localGraph(web, 'lone.md', 2)).toEqual({ nodes: [{ path: 'lone.md' }], links: [] });
  expect(localGraph(web, 'nope.md', 2)).toEqual({ nodes: [], links: [] });
});

it('never hides the centre with its type', () => {
  const typed = { nodes: [{ path: 'c.md', type: 'topic' }, { path: 'a.md', type: 'topic' }], links: [{ source: 'c.md', target: 'a.md' }] };
  expect(withoutTypes(typed, new Set(['topic']), 'c.md')).toEqual({ nodes: [typed.nodes[0]], links: [] });
});
