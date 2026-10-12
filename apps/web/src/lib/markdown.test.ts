// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { frontmatterFields, renderMarkdown, splitFrontmatter, toHtml } from './markdown';
import { resolveEmbed, type Embed } from './media';

describe('splitFrontmatter', () => {
  it('splits a leading block', () => {
    expect(splitFrontmatter('---\ntype: x\ntags: [a, b]\n---\n# T\n')).toEqual({ frontmatter: 'type: x\ntags: [a, b]', body: '# T\n' });
  });
  it('ignores notes without one', () => {
    expect(splitFrontmatter('# T\n---\n').frontmatter).toBeNull();
  });
  it('reads key/value pairs', () => {
    expect(frontmatterFields('type: x\ntags: [a, b]')).toEqual([['type', 'x'], ['tags', ['a', 'b']]]);
  });
});

describe('frontmatterFields (#58: readable values)', () => {
  it('reads block lists, inline lists and quoted scalars without YAML syntax', () => {
    const fm = [
      'tags:',
      '  - concept',
      '  - llm',
      '  - "meta"',
      'sources: [karpathy-llm-wiki-gist.md, source-05.md]',
      'related: ["[[entities/andrej-karpathy]]", "[[zettelkasten]]"]',
      'aliases: [LLM-Wiki, "Compiled wiki", \'it\'\'s\']',
      'title: "Hello: world"',
      "note: 'single'",
      'flush:',
      '- a',
      '- b',
      'empty:',
      'none: []',
      'commas: ["a, b", c]',
    ].join('\n');
    expect(frontmatterFields(fm)).toEqual([
      ['tags', ['concept', 'llm', 'meta']],
      ['sources', ['karpathy-llm-wiki-gist.md', 'source-05.md']],
      ['related', ['[[entities/andrej-karpathy]]', '[[zettelkasten]]']],
      ['aliases', ['LLM-Wiki', 'Compiled wiki', "it's"]],
      ['title', 'Hello: world'],
      ['note', 'single'],
      ['flush', ['a', 'b']],
      ['empty', ''],
      ['none', []],
      ['commas', ['a, b', 'c']],
    ]);
  });

  it('joins continued plain scalars and keeps unknown shapes as raw text', () => {
    const fm = [
      'summary: first',
      '  second',
      'nested:',
      '  a: 1',
      '  b: [x]',
      'block: |',
      '  line one',
      '  line two',
      'broken: [a, b',
      'map: {a: 1}',
      '# a comment',
      'last: x # not a comment in this parser',
    ].join('\n');
    expect(frontmatterFields(fm)).toEqual([
      ['summary', 'first second'],
      ['nested', 'a: 1\nb: [x]'],
      ['block', 'line one\nline two'],
      ['broken', '[a, b'],
      ['map', '{a: 1}'],
      ['last', 'x # not a comment in this parser'],
    ]);
  });
});

describe('toHtml', () => {
  it('renders wikilinks with alias and missing marker', () => {
    const html = toHtml('See [[concepts/llm-wiki|the wiki]] and [[nope]].', (t) => t === 'concepts/llm-wiki');
    expect(html).toContain('<a href="#" class="wl" data-target="concepts/llm-wiki|the wiki">the wiki</a>');
    expect(html).toContain('<a href="#" class="wl miss" data-target="nope">nope</a>');
  });
  it('#118 an aliased wikilink in a table row, written with the escaped pipe', () => {
    const html = toHtml('| Person | Rolle |\n|---|---|\n| [[nadine-gartner\\|Nadine]] | kommt |\n', (t) => t === 'nadine-gartner');
    const row = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tbody tr td');
    expect(row).toHaveLength(2);
    const a = row[0]!.querySelector('a.wl')!;
    expect(a.className).toBe('wl');
    expect(a.textContent).toBe('Nadine');
  });
});

describe('renderMarkdown (Obsidian syntax)', () => {
  const r = (md: string) => renderMarkdown(md, { exists: () => true });

  it('#102 task list items keep a non-interactive marker (no input)', () => {
    const html = r('- [x] done\n- [ ] open\n');
    expect(html).not.toContain('<input');
    expect(html).toContain('data-done="true"');
    expect(html).toContain('data-done="false"');
    expect(html).toContain('☑');
    expect(html).toContain('☐');
    expect(html).toContain('done');
  });

  it('#111 callouts become a titled block', () => {
    const html = r('> [!warning] Careful\n> Hot **stuff**\n> second line\n\n> [!note]-\n> body\n\n> plain quote\n');
    expect(html).toContain('<div class="callout" data-callout="warning">');
    expect(html).toContain('<div class="callout-title">Careful</div>');
    expect(html).toMatch(/<div class="callout-body">[\s\S]*Hot <strong>stuff<\/strong>[\s\S]*second line[\s\S]*<\/div>/);
    expect(html).toContain('data-callout="note"');
    expect(html).toContain('<div class="callout-title">Note</div>');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('[!');
  });

  it('#112 %%comments%% are hidden, except in code', () => {
    const html = r('a %%secret%% b\n\n%%\nmulti\nline\n%%\n\nkeep `%%code%%` here\n\n```\n%%block%%\n```\n');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('multi');
    expect(html).toContain('<code>%%code%%</code>');
    expect(html).toContain('%%block%%');
    expect(html).toContain('a  b');
  });

  it('#113 ==highlight== becomes <mark>', () => {
    expect(r('x ==hot== y')).toContain('<mark>hot</mark>');
    expect(r('`==no==`')).not.toContain('<mark>');
  });

  it('#114 ![[note]] renders as an embed link without "!"', () => {
    const html = r('see ![[concepts/x|Label]] now');
    expect(html).toMatch(/<a [^>]*class="wl embed"[^>]*data-target="concepts\/x\|Label"[^>]*>Label<\/a>/);
    expect(html).not.toContain('!<a');
    expect(html).not.toContain('![[');
  });

  it('#115 footnotes render a superscript link and a footnotes section', () => {
    const html = r('Claim[^1] and more[^note].\n\n[^1]: First *source*.\n[^note]: Second.\n');
    expect(html).toMatch(/<sup[^>]*><a href="#fn-1"[^>]*>1<\/a><\/sup>/);
    expect(html).toMatch(/<sup[^>]*><a href="#fn-2"[^>]*>2<\/a><\/sup>/);
    expect(html).toContain('<section class="footnotes">');
    expect(html).toMatch(/<li id="fn-1">[\s\S]*First <em>source<\/em>\./);
    expect(html).toContain('id="fn-2"');
    expect(html).not.toContain('[^');
  });

  it('#115 nested footnote reference gets its own list item', () => {
    const html = r('A[^1].\n\n[^1]: see [^2]\n[^2]: deep\n');
    expect(html).toContain('href="#fn-2"');
    expect(html).toMatch(/<li id="fn-2">[\s\S]*deep/);
  });
});

describe('renderMarkdown source lines (Read mode position)', () => {
  const note = '---\ntitle: x\n---\n\n# A\n\npara\n\n- one\n- two\n- three\n\n```js\ncode\n```\n';
  const { body } = splitFrontmatter(note);
  const lineOf = (md: string, start: number) => renderMarkdown(md, { exists: () => true }, start);

  it('top-level blocks carry data-line', () => {
    const html = lineOf(body, 4);
    expect(html).toContain('<h1 data-line="5"');
    expect(html).toContain('<p data-line="7"');
    expect(html).toContain('<ul data-line="9"');
    expect(html).toMatch(/<pre[^>]*data-line="13"[^>]*><code/);
    expect(html).not.toMatch(/<li data-line/);
    expect(html.match(/data-line/g)).toHaveLength(4);
  });

  it('adds nothing else to the HTML', () => {
    const plain = renderMarkdown(body, { exists: () => true });
    expect(plain).not.toContain('data-line');
    expect(lineOf(body, 4).replace(/ data-line="\d+"/g, '')).toBe(plain);
  });

  it('counts the lines of removed comments and footnote definitions', () => {
    const md = '%%\nmulti\nline\n%%\n\n# H\n\n[^1]: def\n\ntext[^1]\n';
    const html = lineOf(md, 1);
    expect(html).toContain('<h1 data-line="6"');
    expect(html).toContain('<p data-line="10"');
  });
});

describe('renderMarkdown embeds', () => {
  const paths = ['raw/media/a.png', 'Other.md', 'doc.pdf'];
  const ctx = {
    exists: (t: string) => t === 'Other',
    resolveEmbed: (e: Embed) => resolveEmbed(e, 'n.md', paths),
  };
  it('become sanitized placeholders, never <img src>', () => {
    const html = renderMarkdown('![[a.png|300]] and ![](https://t.example/p.gif)', ctx);
    expect(html).toContain('<span class="embed" data-path="raw/media/a.png" data-kind="image" data-width="300"');
    expect(html).toMatch(/<a [^>]*href="https:\/\/t\.example\/p\.gif"/);
    expect(html).not.toContain('<img');
  });
  it('cover the Markdown form, files and missing targets', () => {
    const html = renderMarkdown('![cap](raw/media/a.png)\n\n![[doc.pdf]]\n\n![[gone.png]]', ctx);
    expect(html).toContain('data-path="raw/media/a.png" data-kind="image" data-alt="cap"');
    expect(html).toContain('data-path="doc.pdf" data-kind="file"');
    expect(html).toContain('class="embed miss" data-target="gone.png"');
  });
  it('keep a note embed as a plain wikilink', () => {
    const html = renderMarkdown('![[Other]]', ctx);
    expect(html).toContain('class="wl embed"');
    expect(html).not.toContain('class="embed"');
  });
  it('escape what comes from the note', () => {
    const html = renderMarkdown('![[a.png|x" onerror="alert(1)]]', ctx);
    expect(html).not.toContain('onerror="');
  });
  it('remote images are links that open in a new tab, also protocol-relative ones; data:image stays an image', () => {
    const html = renderMarkdown('![a](https://t.example/p.gif) ![b](//t.example/q.png) ![](data:image/png;base64,AAAA)', ctx);
    expect(html).toMatch(/<a [^>]*href="https:\/\/t\.example\/p\.gif"/);
    expect(html).toMatch(/<a [^>]*href="\/\/t\.example\/q\.png"/);
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
  });
  it('raw HTML in a note cannot forge a placeholder', () => {
    const html = renderMarkdown('<span class="embed" data-path="raw/media/a.png" data-kind="image" data-ek="guess">x</span> <div class="embed miss" data-target="t"></div>\n\n![[a.png]]', ctx);
    expect(html.match(/class="embed"/g)).toHaveLength(1); // only the real one
    expect(html).not.toContain('data-ek');
    expect(html).not.toContain('data-target');
    expect(html.match(/data-path/g)).toHaveLength(1);
  });
  it('an image inside a link keeps the link', () => {
    const html = renderMarkdown('[![](a.png)](https://x.example/)', { ...ctx, resolveEmbed: (e) => resolveEmbed(e, null, ['a.png']) });
    expect(html).toMatch(/<a [^>]*href="https:\/\/x\.example\/"[^>]*><span class="embed" data-path="a\.png"/);
  });
});
