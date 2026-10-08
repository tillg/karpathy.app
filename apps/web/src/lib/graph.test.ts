import { expect, it } from 'vitest';
import { shownGraph, typeColors, withoutTypes } from './graph';

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
