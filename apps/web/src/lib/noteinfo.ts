// Note info (#79): words, characters and reading time, by the user's language rules (the browser's segmenter).

export const WORDS_PER_MINUTE = 220;

const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Word-like segments (Markdown punctuation doesn't count) and graphemes without line breaks. */
export function countText(s: string): { words: number; chars: number } {
  let w = 0;
  for (const seg of words.segment(s)) if (seg.isWordLike) w++;
  let c = 0;
  for (const seg of graphemes.segment(s)) if (seg.segment !== '\n' && seg.segment !== '\r' && seg.segment !== '\r\n') c++;
  return { words: w, chars: c };
}

/** Whole minutes at a fixed rate for every language, rounded up; 0 words → 0. */
export const readingMinutes = (words: number) => Math.ceil(words / WORDS_PER_MINUTE);
