import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanSuggestion, MAX_SUGGESTION } from '../../../deploy/opencode/lib/suggestion.js';

// The suggest_next tool's check (the tool itself runs inside opencode; see opencode-tools.test.ts).

describe('cleanSuggestion', () => {
  it('trims and collapses whitespace into one line', () => {
    expect(cleanSuggestion('  Summarize   the\nopen points \t')).toBe('suggested: Summarize the open points');
  });

  it('refuses an empty prompt', () => {
    expect(() => cleanSuggestion('  \n ')).toThrow('empty');
  });

  it('refuses a prompt over the limit, so the model shortens it', () => {
    expect(cleanSuggestion('x'.repeat(MAX_SUGGESTION))).toBe(`suggested: ${'x'.repeat(MAX_SUGGESTION)}`);
    expect(() => cleanSuggestion('x'.repeat(MAX_SUGGESTION + 1))).toThrow('too long');
  });
});

describe('suggest_next description', () => {
  it('tells the model to call it at most once, last, in the user\'s language', async () => {
    const src = await readFile(join(import.meta.dirname, '../../../deploy/opencode/tools/suggest_next.ts'), 'utf8');
    expect(src).toMatch(/at most once/);
    expect(src).toMatch(/last/);
    expect(src).toMatch(/language/);
  });
});
