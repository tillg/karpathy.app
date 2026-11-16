import { describe, expect, it } from 'vitest';
import { joinSelection, linksAt } from './term-links';

const pad = (s: string, cols: number) => s.padEnd(cols, ' ');

describe('linksAt: URLs in terminal rows, across hard line breaks at the right edge', () => {
  it('joins a URL that a program wrapped itself (full rows, the rest at the start of the next)', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&scope=org%3Acreate_api_key+user%3Aprofile&state=4r5aaahE0K';
    const cols = 40;
    const rows = ['Use the url below to sign in', url.slice(0, 40), url.slice(40, 80), pad(url.slice(80), cols), '', 'Paste code here >'];
    for (const y of [1, 2, 3]) {
      const links = linksAt(rows, cols, y);
      expect(links).toEqual([{ url, start: { x: 0, y: 1 }, end: { x: url.length - 80 - 1, y: 3 } }]);
    }
  });

  it('a URL that ends before the edge stays one row; the next row is not glued on', () => {
    const cols = 40;
    const rows = ['see https://example.com/a now', 'https://other.example/b'];
    expect(linksAt(rows, cols, 0)).toEqual([{ url: 'https://example.com/a', start: { x: 4, y: 0 }, end: { x: 24, y: 0 } }]);
    expect(linksAt(rows, cols, 1)).toEqual([{ url: 'https://other.example/b', start: { x: 0, y: 1 }, end: { x: 22, y: 1 } }]);
  });

  it('a URL running to the edge takes the next row up to its first space', () => {
    const cols = 30;
    const rows = ['x https://a.example/' + 'p'.repeat(10), 'continued text'];
    expect(rows[0]).toHaveLength(30);
    expect(linksAt(rows, cols, 1)[0]?.url).toBe('https://a.example/ppppppppppcontinued');
  });

  it('a row that starts with a space is never a continuation', () => {
    const cols = 30;
    const rows = ['x https://a.example/' + 'p'.repeat(10), ' next'];
    expect(linksAt(rows, cols, 0)[0]?.url).toBe('https://a.example/pppppppppp');
    expect(linksAt(rows, cols, 1)).toEqual([]);
  });

  it('copying: line breaks after rows that run to the edge go; others stay', () => {
    const cols = 10;
    const rows = ['https://ab', 'cdefghijkl', 'mn', 'next line', 'abcdefghij', ' indented'];
    const selected = 'https://ab\ncdefghijkl\nmn\nnext line\nabcdefghij\n indented';
    expect(joinSelection(selected, rows, cols)).toBe('https://abcdefghijklmn\nnext line\nabcdefghij\n indented');
    // A selection starting mid-row: its first line is short, but the row is full.
    expect(joinSelection('//ab\ncdefghijkl\nmn', rows, cols)).toBe('//abcdefghijklmn');
  });

  it('no URL, no links', () => {
    expect(linksAt(['hello', 'world'], 10, 0)).toEqual([]);
  });
});
