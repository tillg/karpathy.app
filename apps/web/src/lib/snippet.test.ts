import { describe, expect, it } from 'vitest';
import { snippet } from './snippet';

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
