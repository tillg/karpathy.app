import { describe, expect, it } from 'vitest';
import { currentHeading, outlineOfText } from './outline';

describe('outlineOfText', () => {
  it('ATX and setext headings, in order, with level and line', () => {
    const text = ['# A', '', '## B', '', 'C', '===', '', 'D', '---', '', '###### F', '', '## G ##', ''].join('\n');
    expect(outlineOfText(text)).toEqual([
      { level: 1, text: 'A', line: 1 },
      { level: 2, text: 'B', line: 3 },
      { level: 1, text: 'C', line: 5 },
      { level: 2, text: 'D', line: 8 },
      { level: 6, text: 'F', line: 11 },
      { level: 2, text: 'G', line: 13 },
    ]);
  });

  it('skips fenced code, indented code, the frontmatter and %% comments', () => {
    const text = [
      '---', 'title: x', '---', // without the skip, `title: x` + `---` is a setext h2
      '# Real', // 4
      '',
      '```', '# fake', '```',
      '',
      '    # code',
      '',
      '%%', '# hidden', '%%',
      '',
      '## After', // 16
      '',
    ].join('\n');
    expect(outlineOfText(text)).toEqual([
      { level: 1, text: 'Real', line: 4 },
      { level: 2, text: 'After', line: 16 },
    ]);
  });

  it('display text', () => {
    const text = ['## See [[notes/foo|Foo]] and **bold** _x_ ==y== `code`', '', '##', '', '# A #', ''].join('\n');
    expect(outlineOfText(text).map((i) => i.text)).toEqual(['See Foo and bold x y code', '(untitled)', 'A']);
  });
});

describe('currentHeading', () => {
  it('current heading', () => {
    const items = [3, 10, 20].map((line) => ({ level: 2 as const, text: 'x', line }));
    expect([1, 3, 15, 99].map((top) => currentHeading(items, top))).toEqual([-1, 0, 1, 2]);
    expect(currentHeading([], 5)).toBe(-1);
  });
});
