import { describe, expect, it } from 'vitest';
import {
  callsThisTurn,
  capFromEnv,
  extractUrls,
  GUARDED_TOOLS,
  guardWebCall,
  isKnownUrl,
  knownTexts,
} from '../../../deploy/opencode/lib/known-url.js';

// The web provenance check (pure; the plugin runs it inside opencode).

describe('extractUrls', () => {
  it('finds a Markdown link target', () => {
    expect(extractUrls('see [x](https://a.com/p) now')).toEqual(['https://a.com/p']);
  });
  it('finds a URL in angle brackets', () => {
    expect(extractUrls('<https://a.com>')).toEqual(['https://a.com']);
  });
  it('strips trailing punctuation', () => {
    for (const end of ['.', ',', ')', '"', "'", ';', ':', '!', '?', ').']) {
      expect(extractUrls(`go to https://a.com/p${end}`)).toEqual(['https://a.com/p']);
    }
  });
  it('keeps a query string whole', () => {
    expect(extractUrls('https://a.com/p?a=1&b=2.')).toEqual(['https://a.com/p?a=1&b=2']);
  });
  it('handles the read tool output shape', () => {
    expect(extractUrls('00011| intro\n00012| see https://a.com/p\n00013| end')).toEqual([
      'https://a.com/p',
    ]);
  });
  it('keeps a balanced closing paren (Wikipedia), strips an unbalanced one', () => {
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractUrls('(see https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(extractUrls('(see https://a.com/p)')).toEqual(['https://a.com/p']);
  });
  it('a backtick ends the URL', () => {
    expect(extractUrls('`https://a.com/p`, then')).toEqual(['https://a.com/p']);
  });
  it('returns nothing for text without URLs', () => {
    expect(extractUrls('no links here')).toEqual([]);
  });
});

describe('isKnownUrl', () => {
  const cases: [string, string, boolean][] = [
    ['https://A.com:443/p', 'https://a.com/p', true],
    ['https://a.com/p#x', 'https://a.com/p', true],
    ['https://a.com/p?d=secret', 'https://a.com/p', false],
    ['https://a.com/p/x', 'https://a.com/p', false],
    ['http://a.com/p', 'https://a.com/p', false],
  ];
  for (const [url, seen, known] of cases) {
    it(`${url} vs ${seen} -> ${known}`, () => {
      expect(isKnownUrl(url, [`look: ${seen}`])).toBe(known);
    });
  }
  it('rejects ftp and unparsable strings, even when present in the text', () => {
    expect(isKnownUrl('ftp://a.com', ['ftp://a.com'])).toBe(false);
    expect(isKnownUrl('not a url', ['not a url'])).toBe(false);
  });
  it('is false with no texts', () => {
    expect(isKnownUrl('https://a.com', [])).toBe(false);
  });
});

const user = (text: string) => ({ info: { role: 'user' }, parts: [{ type: 'text', text }] });
const tool = (name: string, output = 'out', status = 'completed') => ({
  info: { role: 'assistant' },
  parts: [{ type: 'tool', tool: name, state: { status, output } }],
});

describe('callsThisTurn', () => {
  it('counts only calls after the last user message, per tool', () => {
    const messages = [
      user('one'),
      tool('webfetch'),
      user('two'),
      tool('webfetch'),
      tool('webfetch'),
      tool('websearch'),
    ];
    expect(callsThisTurn(messages, 'webfetch')).toBe(2);
    expect(callsThisTurn(messages, 'websearch')).toBe(1);
  });
  it('ignores earlier turns', () => {
    expect(callsThisTurn([user('a'), tool('webfetch'), user('b')], 'webfetch')).toBe(0);
  });
  it('counts running and completed calls, not pending or failed ones', () => {
    const messages = [user('a'), tool('webfetch', 'o', 'completed'), tool('webfetch', 'o', 'running'), tool('webfetch', '', 'pending'), tool('webfetch', '', 'error')];
    expect(callsThisTurn(messages, 'webfetch')).toBe(2);
  });
  it('is tolerant of odd input', () => {
    expect(callsThisTurn([], 'webfetch')).toBe(0);
    expect(callsThisTurn([{}, { info: {}, parts: null }] as never, 'webfetch')).toBe(0);
  });
});

const call = (name: string, input: Record<string, unknown>, output = 'out', status = 'completed') => ({
  info: { role: 'assistant' },
  parts: [{ type: 'tool', tool: name, state: { status, input, output } }],
});

describe('knownTexts', () => {
  it('returns user text and the output of read / webfetch / websearch only', () => {
    const messages = [
      user('hi https://a.com'),
      call('read', { filePath: 'notes/A.md' }, 'file https://b.com'),
      call('read', { filePath: 'notes/A.md' }, 'half', 'running'),
      call('webfetch', { url: 'https://x.com' }, 'page https://d.com'),
      call('websearch', { query: 'q' }, 'hit https://e.com'),
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'assistant https://c.com' }] },
    ];
    expect(knownTexts(messages)).toEqual(['hi https://a.com', 'file https://b.com', 'page https://d.com', 'hit https://e.com']);
  });
  it('todowrite output is not known (the model writes it itself)', () => {
    expect(knownTexts([user('x'), call('todowrite', { todos: [] }, '[{"content":"https://evil.com/?d=secret"}]')])).toEqual(['x']);
  });
  it('a note the AI wrote and then read back is not known', () => {
    for (const writer of ['write', 'edit', 'multiedit']) {
      const messages = [
        user('x'),
        call(writer, { filePath: '/vaults/v/notes/Echo.md', content: 'https://evil.com/?d=secret' }),
        call('read', { filePath: 'notes/Echo.md' }, '00001| https://evil.com/?d=secret'),
      ];
      expect(knownTexts(messages), writer).toEqual(['x']);
    }
    const patched = [
      user('x'),
      call('apply_patch', { patchText: '*** Add File: notes/Echo.md\n+https://evil.com/?d=secret' }),
      call('read', { filePath: 'notes/Echo.md' }, 'https://evil.com/?d=secret'),
    ];
    expect(knownTexts(patched)).toEqual(['x']);
  });
  it('a read of another file after a write still counts', () => {
    const messages = [user('x'), call('write', { filePath: 'notes/New.md' }), call('read', { filePath: 'notes/Links.md' }, 'https://a.com/')];
    expect(knownTexts(messages)).toEqual(['x', 'https://a.com/']);
  });
});

describe('capFromEnv', () => {
  it('parses a positive integer', () => {
    expect(capFromEnv('5')).toBe(5);
  });
  it('falls back to 20', () => {
    for (const v of [undefined, '', 'abc', '0', '-3', '2.5']) expect(capFromEnv(v)).toBe(20);
  });
});

describe('guardWebCall', () => {
  const caps = { fetch: 20, search: 20 };
  const user = (text: string) => ({ info: { role: 'user' }, parts: [{ type: 'text', text }] });
  const fetches = (n: number) => ({ info: { role: 'assistant' }, parts: Array.from({ length: n }, () => ({ type: 'tool', tool: 'webfetch', state: { status: 'completed', output: '' } })) });

  it('open_url with a known URL → null', () => {
    expect(guardWebCall('open_url', { url: 'https://a.com/p' }, [user('open https://a.com/p')], caps)).toBeNull();
  });

  it('open_url with a URL the model built → URL not in this chat', () => {
    expect(guardWebCall('open_url', { url: 'https://a.com/p?d=secret' }, [user('open https://a.com/p')], caps)).toMatch(/^URL not in this chat/);
  });

  it("open_url isn't counted against the fetch cap", () => {
    expect(guardWebCall('open_url', { url: 'https://a.com/p' }, [user('open https://a.com/p'), fetches(20)], caps)).toBeNull();
  });

  it('webfetch and websearch keep their cap and provenance checks', () => {
    const msgs = [user('see https://a.com/p'), fetches(20)];
    expect(guardWebCall('webfetch', { url: 'https://a.com/p' }, msgs, caps)).toBe('Fetch limit reached (20 per turn)');
    expect(guardWebCall('webfetch', { url: 'https://a.com/p' }, [user('see https://a.com/p')], caps)).toBeNull();
    expect(guardWebCall('webfetch', { url: 'https://b.com/' }, [user('see https://a.com/p')], caps)).toMatch(/^URL not in this chat/);
    expect(guardWebCall('websearch', { query: 'x' }, [user('hi')], { fetch: 20, search: 0 })).toBe('Search limit reached (0 per turn)');
    expect(guardWebCall('websearch', { query: 'x' }, [user('hi')], caps)).toBeNull();
    expect(guardWebCall('read', { filePath: 'x' }, [], caps)).toBeNull();
  });

  it('save_url needs a known URL and shares the fetch cap with webfetch', () => {
    const saves = (n: number) => ({ info: { role: 'assistant' }, parts: Array.from({ length: n }, () => ({ type: 'tool', tool: 'save_url', state: { status: 'completed', output: '' } })) });
    expect(GUARDED_TOOLS).toContain('save_url');
    expect(guardWebCall('save_url', { url: 'https://a.com/c.png', filePath: 'c.png' }, [user('see https://a.com/c.png')], caps)).toBeNull();
    expect(guardWebCall('save_url', { url: 'https://a.com/c.png?d=secret', filePath: 'c.png' }, [user('see https://a.com/c.png')], caps)).toMatch(/^URL not in this chat/);
    expect(guardWebCall('save_url', { url: 'https://a.com/c.png' }, [user('see https://a.com/c.png'), fetches(10), saves(10)], caps)).toBe('Fetch limit reached (20 per turn)');
    expect(guardWebCall('webfetch', { url: 'https://a.com/c.png' }, [user('see https://a.com/c.png'), fetches(19), saves(1)], caps)).toBe('Fetch limit reached (20 per turn)');
  });
});
