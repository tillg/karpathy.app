// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '@karpathy/shared';
import { chipCommands, filterCommands, paletteQuery, recentCommands, recordCommand } from './commands';

const v = (name: string): Command => ({ name, description: `${name} skill`, source: 'vault' });
const a = (name: string): Command => ({ name, description: `${name} skill`, source: 'app' });

describe('paletteQuery', () => {
  it('is the partial name while the text is / plus name characters', () => {
    expect(paletteQuery('/')).toBe('');
    expect(paletteQuery('/qu')).toBe('qu');
    expect(paletteQuery('/query x')).toBeNull();
    expect(paletteQuery('hi /q')).toBeNull();
    expect(paletteQuery('')).toBeNull();
  });
});

describe('filterCommands', () => {
  it('keeps vault skills before app skills, prefix matches first in each group', () => {
    const list = [v('lint'), v('ingest'), v('query'), a('research'), a('search-web')];
    expect(filterCommands(list, '').map((c) => c.name)).toEqual(['ingest', 'lint', 'query', 'research', 'search-web']);
    expect(filterCommands(list, 'SE').map((c) => c.name)).toEqual(['search-web', 'research']);
    expect(filterCommands(list, 'in').map((c) => c.name)).toEqual(['ingest', 'lint']);
    expect(filterCommands([a('reach'), v('preach')], 're').map((c) => c.name)).toEqual(['preach', 'reach']);
  });
});

describe('chipCommands', () => {
  it('takes recent names still in the list, then A–Z, at most 4', () => {
    const list = [v('a'), v('b'), v('c'), v('d'), v('e')];
    expect(chipCommands(list, ['e', 'gone', 'c']).map((c) => c.name)).toEqual(['e', 'c', 'a', 'b']);
    expect(chipCommands(list, []).map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(chipCommands(list.slice(0, 2), ['b'], 4).map((c) => c.name)).toEqual(['b', 'a']);
  });
});

describe('recent commands', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recordCommand puts the newest first, at most 10, per vault', () => {
    localStorage.clear();
    for (let i = 0; i < 12; i++) recordCommand('v1', `c${i}`);
    recordCommand('v1', 'c5');
    expect(recentCommands('v1')).toEqual(['c5', 'c11', 'c10', 'c9', 'c8', 'c7', 'c6', 'c4', 'c3', 'c2']);
    expect(recentCommands('v2')).toEqual([]);
  });

  it('recent list survives without localStorage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => recordCommand('v1', 'x')).not.toThrow();
    expect(recentCommands('v1')).toEqual([]);
    expect(chipCommands([v('b'), v('a')], recentCommands('v1')).map((c) => c.name)).toEqual(['a', 'b']);
  });
});
