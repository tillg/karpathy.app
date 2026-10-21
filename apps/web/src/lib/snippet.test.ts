import { describe, expect, it } from 'vitest';
import { markedSnippet, snippet } from './snippet';

describe('snippet (#54)', () => {
  const line = 'related: [jarvis, vannevar-bush, zettelkasten, mémoire-de-travail, other, more, and, more, words]';

  it('centers the match in the budget', () => {
    const s = snippet(line, 'mémoire', 31)!;
    expect(s.hit).toBe('mémoire');
    const pre = s.pre.replace(/^…/, '');
    const post = s.post.replace(/…$/, '');
    expect(pre.length + s.hit.length + post.length).toBeLessThanOrEqual(31);
    expect(Math.abs(pre.length - post.length)).toBeLessThanOrEqual(1);
    expect(s.pre.startsWith('…')).toBe(true);
    expect(s.post.endsWith('…')).toBe(true);
  });

  it('shows the whole line when it fits', () => {
    expect(snippet('a mémoire b', 'MÉMOIRE', 40)).toEqual({ pre: 'a ', hit: 'mémoire', post: ' b' });
  });

  it('gives unused room on one side to the other', () => {
    const s = snippet('mémoire and a long tail of words after the match', 'mémoire', 20)!;
    expect(s.pre).toBe('');
    expect(s.post).toBe(' and a long t…');
    const e = snippet('a long head of words before the match mémoire', 'mémoire', 20)!;
    expect(e.post).toBe('');
    expect(e.pre).toBe('…re the match ');
  });

  it('keeps the match even when it alone exceeds the budget', () => {
    expect(snippet('xx mémoire yy', 'mémoire', 4)!.hit).toBe('mémoire');
  });

  it('returns null without a match', () => {
    expect(snippet('abc', 'z', 20)).toBeNull();
    expect(snippet('abc', '', 20)).toBeNull();
  });
});

describe('markedSnippet (#138): the server marks the words (stems, umlauts)', () => {
  it('centers the first range and marks every range in the window', () => {
    const text = 'Neue Handtücher und Handtuch kaufen';
    expect(markedSnippet(text, [[5, 15], [20, 28]], 80)).toEqual([
      { text: 'Neue ', hit: false },
      { text: 'Handtücher', hit: true },
      { text: ' und ', hit: false },
      { text: 'Handtuch', hit: true },
      { text: ' kaufen', hit: false },
    ]);
  });

  it('cuts around the first range; a range cut by the window is marked as far as it shows', () => {
    const text = `${'x'.repeat(40)} Handtücher ${'y'.repeat(40)}`;
    const parts = markedSnippet(text, [[41, 51]], 20);
    expect(parts.find((p) => p.hit)!.text).toBe('Handtücher');
    expect(parts[0]!.text.startsWith('…')).toBe(true);
    expect(parts.at(-1)!.text.endsWith('…')).toBe(true);
  });

  it('without ranges: the whole text, nothing marked', () => {
    expect(markedSnippet('abc', [], 20)).toEqual([{ text: 'abc', hit: false }]);
  });
});
