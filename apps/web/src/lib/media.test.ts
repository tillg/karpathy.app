// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EMBED_RE, parseEmbed, resolveEmbed, sanitizeSvg } from './media';

describe('parseEmbed', () => {
  it('parses the wikilink form with a width or a caption', () => {
    expect(parseEmbed('![[a.png]]')).toMatchObject({ form: 'wiki', target: 'a.png' });
    expect(parseEmbed('![[a.png|300]]')).toMatchObject({ target: 'a.png', width: 300 });
    expect(parseEmbed('![[a.png|300x200]]')).toMatchObject({ target: 'a.png', width: 300 });
    // #118: the table-safe escaped pipe.
    expect(parseEmbed('![[a.png\\|300]]')).toMatchObject({ target: 'a.png', width: 300 });
    expect(parseEmbed('![[clip.mp4|200]]')).toMatchObject({ target: 'clip.mp4', width: 200 });
    const cap = parseEmbed('![[a.png|Caption]]')!;
    expect(cap.alt).toBe('Caption');
    expect(cap.width).toBeUndefined();
  });
  it('parses the Markdown form, decoding the path', () => {
    expect(parseEmbed('![x](b%20c.png)')).toMatchObject({ form: 'md', target: 'b c.png', alt: 'x' });
    expect(parseEmbed('![](a.png "A title")')).toMatchObject({ form: 'md', target: 'a.png' });
  });
  it('is not an embed without the bang', () => {
    expect(parseEmbed('[[a.png]]')).toBeNull();
    expect(parseEmbed('[x](a.png)')).toBeNull();
  });
});

describe('resolveEmbed', () => {
  const paths = ['Notes/n.md', 'raw/media/a.png', 'Notes/img/b.png', 'doc.pdf', 'Other.md', 'clip.mp4'];
  const r = (raw: string, note: string | null = 'Notes/n.md') => resolveEmbed(parseEmbed(raw)!, note, paths);
  it('finds a wikilink embed by basename', () => {
    expect(r('![[a.png|300]]')).toMatchObject({ state: 'media', path: 'raw/media/a.png', kind: 'image', width: 300 });
    expect(r('![[clip.mp4]]')).toMatchObject({ state: 'media', path: 'clip.mp4', kind: 'video' });
  });
  it('resolves the Markdown form relative to the note', () => {
    expect(r('![](img/b.png)')).toMatchObject({ state: 'media', path: 'Notes/img/b.png' });
    expect(r('![](/doc.pdf)')).toEqual({ state: 'file', path: 'doc.pdf' });
    expect(r('![](../../x.png)')).toMatchObject({ state: 'missing' });
    expect(r('![](raw/media/a.png)', null)).toMatchObject({ state: 'media', path: 'raw/media/a.png' });
  });
  it('maps notes, remote and missing targets', () => {
    expect(r('![[Other]]')).toEqual({ state: 'note', inner: 'Other' });
    expect(r('![[Other#Heading|x]]')).toMatchObject({ state: 'note', inner: 'Other#Heading|x' });
    expect(r('![](https://x/y.png)')).toEqual({ state: 'remote', href: 'https://x/y.png' });
    expect(r('![](data:image/png;base64,AAAA)')).toMatchObject({ state: 'remote' });
    expect(r('![](//x/y.png)')).toMatchObject({ state: 'remote' });
    expect(r('![[nope.png]]')).toMatchObject({ state: 'missing', target: 'nope.png' });
  });
  it('treats a non-media, non-note file as a file card', () => {
    expect(r('![[doc.pdf]]')).toEqual({ state: 'file', path: 'doc.pdf' });
  });
});

describe('EMBED_RE', () => {
  it('matches both forms, a path with parentheses included', () => {
    const m = [...'a ![[x.png|20]] b ![cap](photo (1).png) c ![](plain.png)'.matchAll(EMBED_RE)];
    expect(m.map((x) => x[0])).toEqual(['![[x.png|20]]', '![cap](photo (1).png)', '![](plain.png)']);
    expect(parseEmbed(m[1]![0])).toMatchObject({ target: 'photo (1).png', alt: 'cap' });
  });
});

describe('sanitizeSvg', () => {
  it('drops script and event handlers, keeps the drawing', () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="alert(1)"><script>alert(2)</script><circle cx="2" cy="2" r="1" onclick="alert(3)"/><a href="javascript:alert(4)"><rect width="1" height="1"/></a></svg>');
    expect(out).toContain('<circle');
    expect(out).toContain('<rect');
    expect(out).not.toMatch(/script|onload|onclick|javascript:/i);
  });
});
