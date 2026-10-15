import { describe, expect, it } from 'vitest';
import { formatAdminRoute, formatRoute, parseRoute, routeState } from './route';

it('round-trips vault and path, incl. spaces, unicode and #', () => {
  for (const path of ['Home.md', 'raw/articles/Graph Wissen 0.md', 'wiki/Réflexion #1?.md']) {
    const h = formatRoute('big', path);
    expect(h.startsWith('#/big/')).toBe(true);
    expect(parseRoute(h)).toEqual({ admin: null, vault: 'big', path });
  }
  expect(formatRoute('big', 'a b/c.md')).toBe('#/big/a%20b/c.md');
});

it('vault only and empty routes', () => {
  expect(formatRoute('v')).toBe('#/v');
  expect(parseRoute('#/v')).toEqual({ admin: null, vault: 'v', path: null });
  expect(formatRoute(null)).toBe('');
  for (const h of ['', '#', '#/', '#foo', '#/%E0%A4%A']) expect(parseRoute(h)).toEqual({ admin: null, vault: null, path: null });
  // #49: a trailing slash still names the vault.
  expect(parseRoute('#/v/')).toEqual({ admin: null, vault: 'v', path: null });
});

it('admin routes', () => {
  expect(parseRoute('#admin/usage')).toEqual({ admin: 'usage', vault: null, path: null });
  expect(parseRoute('#admin')).toEqual({ admin: '', vault: null, path: null });
  expect(parseRoute('#admin/nope')).toEqual({ admin: 'general', vault: null, path: null });
  expect(parseRoute('#/admin/x')).toEqual({ admin: null, vault: 'admin', path: 'x' });
  expect(formatAdminRoute('ai')).toBe('#admin/ai');
  expect(formatAdminRoute('')).toBe('#admin');
});

describe('routeState (#139)', () => {
  it('a push to a file remembers the file left in the same vault', () => {
    expect(routeState({ vault: 'v', path: 'A.md' }, { vault: 'v', path: 'B.md' }, false, null)).toEqual({ prev: 'A.md' });
  });
  it('media and code files count as files', () => {
    expect(routeState({ vault: 'v', path: 'A.md' }, { vault: 'v', path: 'img/p.png' }, false, null)).toEqual({ prev: 'A.md' });
    expect(routeState({ vault: 'v', path: 'run.py' }, { vault: 'v', path: 'B.md' }, false, null)).toEqual({ prev: 'run.py' });
  });
  it('the first file has no previous file', () => {
    expect(routeState({ vault: 'v', path: null }, { vault: 'v', path: 'A.md' }, false, null)).toEqual({ prev: null });
  });
  it('a vault switch has no previous file', () => {
    expect(routeState({ vault: 'v', path: 'A.md' }, { vault: 'w', path: 'B.md' }, false, null)).toEqual({ prev: null });
  });
  it('a replace (outline jump, move into own folder) keeps the previous file', () => {
    expect(routeState({ vault: 'v', path: 'B.md' }, { vault: 'v', path: 'B/B.md' }, true, { prev: 'A.md' })).toEqual({ prev: 'A.md' });
  });
  it('no file open: no state', () => {
    expect(routeState({ vault: 'v', path: 'A.md' }, { vault: 'v', path: null }, false, null)).toBeNull();
  });
});
