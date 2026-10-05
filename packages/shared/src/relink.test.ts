import { describe, expect, it } from 'vitest';
import { rewriteLinks } from './relink.js';

const from = 'Wiki/serien/foo.md';
const to = 'Wiki/serien/foo/foo.md';
const paths = ['Wiki/serien/foo.md', 'Wiki/filme/foo.md', 'Wiki/x.md', 'Wiki/a/b.md', 'Wiki/other.md', 'Wiki/serien/img/a.png'];
const inbound = (text: string, page = 'Wiki/x.md') => rewriteLinks(text, page, from, to, paths);

describe('rewriteLinks: inbound links', () => {
  it.each([
    ['[[serien/foo]]', '[[serien/foo/foo]]'],
    ['[[serien/foo|Foo]]', '[[serien/foo/foo|Foo]]'],
    ['![[serien/foo#Plot]]', '![[serien/foo/foo#Plot]]'],
    ['[[Wiki/serien/foo.md]]', '[[Wiki/serien/foo/foo.md]]'],
    ['[F](serien/foo.md)', '[F](serien/foo/foo.md)'],
    ['[F](serien/foo.md#Plot)', '[F](serien/foo/foo.md#Plot)'],
  ])('%s → %s', (before, after) => expect(inbound(before)).toBe(after));

  it('rewrites a relative Markdown link from a deeper page', () => {
    expect(inbound('[F](../serien/foo.md)', 'Wiki/a/b.md')).toBe('[F](../serien/foo/foo.md)');
  });

  it('leaves bare links and links to another page of that name alone', () => {
    expect(inbound('[[foo]] and [[foo|Foo]]')).toBe('[[foo]] and [[foo|Foo]]');
    expect(inbound('[[filme/foo]]')).toBe('[[filme/foo]]');
  });

  it('leaves code blocks and code spans alone', () => {
    const text = 'a `[[serien/foo]]` b\n\n```\n[[serien/foo]]\n```\n\n~~~md\n[F](serien/foo.md)\n~~~\n[[serien/foo]]\n';
    expect(inbound(text)).toBe('a `[[serien/foo]]` b\n\n```\n[[serien/foo]]\n```\n\n~~~md\n[F](serien/foo.md)\n~~~\n[[serien/foo/foo]]\n');
  });

  it('keeps the rest of the text byte-identical', () => {
    const text = '---\ntitle: x\n---\n# X\n\nSee [[serien/foo]], then [[foo]].\r\nEnd';
    expect(inbound(text)).toBe('---\ntitle: x\n---\n# X\n\nSee [[serien/foo/foo]], then [[foo]].\r\nEnd');
  });
});

describe('rewriteLinks: inside the moved page', () => {
  const own = (text: string) => rewriteLinks(text, from, from, to, paths);
  it('makes relative links one level deeper', () => {
    expect(own('![](img/a.png)')).toBe('![](../img/a.png)');
    expect(own('[x](../other.md)')).toBe('[x](../../other.md)');
    expect(own('[s](my%20file.md)')).toBe('[s](../my%20file.md)');
  });
  it('leaves wikilinks, embeds by name, absolute links and URLs alone', () => {
    const text = '![[a.png]] [[other]] [r](/Wiki/other.md) [w](https://example.com/a.md) [h](#Plot)';
    expect(own(text)).toBe(text);
  });
});
