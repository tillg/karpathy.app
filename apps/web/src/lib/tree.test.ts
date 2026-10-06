import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@karpathy/shared';
import { ancestors, buildTree, DEFAULT_SORT, loadExpanded, loadSortFilter, saveExpanded, saveSortFilter, type TreeNode } from './tree';

it('nests entries with folders first', () => {
  const t = buildTree([
    { path: 'b.md', type: 'file' },
    { path: 'wiki', type: 'dir' },
    { path: 'wiki/x.md', type: 'file' },
    { path: 'a.md', type: 'file' },
    { path: 'raw/deep/y.md', type: 'file' },
  ]);
  expect(t.map((n) => n.path)).toEqual(['raw', 'wiki', 'a.md', 'b.md']);
  expect(t[0]!.children[0]!.children[0]!.path).toBe('raw/deep/y.md');
  expect(t[1]!.children.map((n) => n.name)).toEqual(['x.md']);
});

describe('folder expansion (#53)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it('lists the folders above a path, outermost first', () => {
    expect(ancestors('wiki/concepts/x.md')).toEqual(['wiki', 'wiki/concepts']);
    expect(ancestors('Home.md')).toEqual([]);
  });

  it('starts collapsed and persists per vault', () => {
    const s = mem();
    expect([...loadExpanded(s, 'v1')]).toEqual([]);
    saveExpanded(s, 'v1', new Set(['wiki', 'wiki/concepts']));
    expect([...loadExpanded(s, 'v1')]).toEqual(['wiki', 'wiki/concepts']);
    expect([...loadExpanded(s, 'v2')]).toEqual([]);
  });

  it('survives broken storage', () => {
    const s = mem();
    s.setItem('karpathy.tree:v1', '{nope');
    expect([...loadExpanded(s, 'v1')]).toEqual([]);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect([...loadExpanded(throwing, 'v1')]).toEqual([]);
    expect(() => saveExpanded(throwing, 'v1', new Set(['a']))).not.toThrow();
  });
});

describe('sort and filter (#122)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const names = (ns: TreeNode[]) => ns.map((n) => n.name);
  const flat: FileEntry[] = [
    { path: 'b.md', type: 'file', modified: 3 },
    { path: 'a.md', type: 'file', modified: 3 },
    { path: 'c.md', type: 'file', modified: 1 },
    { path: 'u.md', type: 'file' },
  ];

  it('explicit defaults give the same tree as no arguments', () => {
    const entries: FileEntry[] = [{ path: 'b.md', type: 'file' }, { path: 'wiki', type: 'dir' }, { path: 'wiki/x.md', type: 'file', modified: 5 }, { path: 'a.md', type: 'file', modified: 9 }];
    expect(buildTree(entries, DEFAULT_SORT, 'any')).toEqual(buildTree(entries));
    expect(names(buildTree(entries))).toEqual(['wiki', 'a.md', 'b.md']);
  });

  it('name desc reverses within folders, folders still first', () => {
    const t = buildTree([{ path: 'a.md', type: 'file' }, { path: 'z.md', type: 'file' }, { path: 'f', type: 'dir' }, { path: 'g/x.md', type: 'file' }, { path: 'g/y.md', type: 'file' }], { by: 'name', dir: 'desc' });
    expect(names(t)).toEqual(['g', 'f', 'z.md', 'a.md']);
    expect(names(t[0]!.children)).toEqual(['y.md', 'x.md']);
  });

  it('changed sorts by date both ways, ties by name, undated last', () => {
    expect(names(buildTree(flat, { by: 'changed', dir: 'desc' }))).toEqual(['a.md', 'b.md', 'c.md', 'u.md']);
    expect(names(buildTree(flat, { by: 'changed', dir: 'asc' }))).toEqual(['c.md', 'a.md', 'b.md', 'u.md']);
  });

  it('ranks folders by newest descendant', () => {
    const entries: FileEntry[] = [
      { path: 'a/y.md', type: 'file', modified: 5 },
      { path: 'b/deep/x.md', type: 'file', modified: 9 },
      { path: 'b/old.md', type: 'file', modified: 1 },
      { path: 'c', type: 'dir' },
    ];
    expect(names(buildTree(entries, { by: 'changed', dir: 'desc' }))).toEqual(['b', 'a', 'c']);
    expect(names(buildTree(entries, { by: 'changed', dir: 'asc' }))).toEqual(['a', 'b', 'c']);
    expect(names(buildTree(entries))).toEqual(['a', 'b', 'c']);
  });

  it('filter ai keeps only AI files and the folders on their way', () => {
    const entries: FileEntry[] = [
      { path: 'w', type: 'dir' },
      { path: 'w/ai.md', type: 'file', modified: 2, ai: 2 },
      { path: 'w/me.md', type: 'file', modified: 3, human: 3 },
      { path: 'empty', type: 'dir' },
      { path: 'x/y/deep.md', type: 'file', ai: 1 },
      { path: 'top.md', type: 'file', human: 1 },
    ];
    const t = buildTree(entries, DEFAULT_SORT, 'ai');
    expect(names(t)).toEqual(['w', 'x']);
    expect(names(t[0]!.children)).toEqual(['ai.md']);
    expect(t[1]!.children[0]!.children[0]!.path).toBe('x/y/deep.md');
    expect(names(buildTree(entries, DEFAULT_SORT, 'human'))).toEqual(['w', 'top.md']);
    expect(names(buildTree(entries))).toEqual(['empty', 'w', 'x', 'top.md']);
  });

  it('the filter picks the date Last changed uses', () => {
    const entries: FileEntry[] = [
      { path: 'p.md', type: 'file', modified: 9, human: 2 },
      { path: 'q.md', type: 'file', modified: 5, human: 4 },
    ];
    expect(names(buildTree(entries, { by: 'changed', dir: 'desc' }, 'human'))).toEqual(['q.md', 'p.md']);
    expect(names(buildTree(entries, { by: 'changed', dir: 'desc' }, 'any'))).toEqual(['p.md', 'q.md']);
  });

  it('sort and filter preference round-trips and falls back', () => {
    const s = mem();
    expect(loadSortFilter(s)).toEqual({ sort: DEFAULT_SORT, filter: 'any' });
    saveSortFilter(s, { sort: { by: 'changed', dir: 'desc' }, filter: 'ai' });
    expect(loadSortFilter(s)).toEqual({ sort: { by: 'changed', dir: 'desc' }, filter: 'ai' });
    s.setItem('karpathy.treeSort', '{nope');
    s.setItem('karpathy.treeFilter', 'bogus');
    expect(loadSortFilter(s)).toEqual({ sort: DEFAULT_SORT, filter: 'any' });
    s.setItem('karpathy.treeSort', JSON.stringify({ by: 'size', dir: 'up' }));
    expect(loadSortFilter(s).sort).toEqual(DEFAULT_SORT);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(loadSortFilter(throwing)).toEqual({ sort: DEFAULT_SORT, filter: 'any' });
    expect(() => saveSortFilter(throwing, { sort: DEFAULT_SORT, filter: 'ai' })).not.toThrow();
  });
});
