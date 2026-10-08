import { describe, expect, it } from 'vitest';
import { countText, readingMinutes } from './noteinfo';

describe('countText', () => {
  it('words and characters', () => {
    expect(countText('Hello, world!')).toEqual({ words: 2, chars: 13 });
    expect(countText('## Über   die Straße').words).toBe(3);
    // Node's ICU word segmenter keeps French elisions in one word: `l'été`, `c'est`.
    expect(countText("l'été c'est").words).toBe(2);
    expect(countText('a\r\nb').chars).toBe(2);
    expect(countText('👍🏽 é').chars).toBe(3);
    expect(countText('[[foo|Bar]] *x*').words).toBe(3);
  });

  it('reading minutes', () => {
    expect([0, 1, 220, 221, 2200].map(readingMinutes)).toEqual([0, 1, 1, 2, 10]);
  });
});
