import { readFileSync } from 'node:fs';
import { CST, Parser } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkEdit, editFrontmatter, readFrontmatter, type Rules } from './frontmatter';
import { splitFrontmatter } from './markdown';

const PROPS = readFileSync(new URL('./fixtures/props.md', import.meta.url), 'utf8');
const FM = splitFrontmatter(PROPS).frontmatter!;

describe('yaml', () => {
  it('yaml CST stringify is lossless', () => {
    const out = [...new Parser().parse(FM)].map((t) => CST.stringify(t)).join('');
    expect(out).toBe(FM);
  });
});

describe('readFrontmatter', () => {
  it('reads properties', () => {
    const fm = readFrontmatter(PROPS)!;
    expect(fm.error).toBeUndefined();
    expect(fm.text).toBe(FM);
    expect(PROPS.slice(fm.from, fm.to)).toBe(FM);
    const by = Object.fromEntries(fm.props.map((p) => [p.key, p]));
    expect(fm.props.map((p) => p.key)).toEqual(['type', 'tags', 'updated', 'confidence', 'sources', 'related', 'summary', 'place', 'title', 'done']);
    expect(fm.props.map((p) => p.lines)).toEqual([[2, 2], [3, 3], [4, 4], [5, 5], [6, 8], [9, 9], [10, 12], [13, 15], [16, 16], [17, 17]]);
    expect(by.type).toMatchObject({ value: 'synthesis', kind: 'text', editable: true });
    expect(by.tags).toMatchObject({ value: ['llm', 'wiki'], kind: 'list', editable: true, list: { flow: true, style: 'bare', ext: false } });
    expect(by.updated).toMatchObject({ value: '2026-10-02', kind: 'date', editable: true });
    expect(by.confidence).toMatchObject({ value: 'high', kind: 'text', editable: true });
    expect(by.sources).toMatchObject({ value: ['[[a]]', '[[b]]'], kind: 'links', editable: true, list: { flow: false, style: 'wikilink' } });
    expect(by.related).toMatchObject({ value: ['[[openai]]', '[[tesla]]'], kind: 'links', list: { flow: true, style: 'wikilink' } });
    expect(by.summary).toMatchObject({ kind: 'raw', editable: false });
    expect(by.place).toMatchObject({ kind: 'raw', editable: false });
    expect(by.title).toMatchObject({ value: 'Props: a test', kind: 'text', editable: true });
    expect(by.done).toMatchObject({ value: null, editable: true });
    // A schema rule wins over the inferred kind.
    expect(readFrontmatter(PROPS, { confidence: { kind: 'enum' } })!.props[3]!.kind).toBe('enum');
  });

  it('errors and no frontmatter', () => {
    for (const fm of ['a: 1\na: 2', '- a\n- b', 'a:\n\t- b']) expect(readFrontmatter(`---\n${fm}\n---\nbody\n`)!.error).toBeTruthy();
    expect(readFrontmatter('# no frontmatter\n')).toBeNull();
    // Found by the property tests: an alias without its anchor is an error, not a crash.
    expect(readFrontmatter('---\nx: *a\n---\n')!.error).toBeTruthy();
  });
});

/** The text of a successful edit (fails the test on a refusal). */
const ok = (r: { text: string } | { refused: string }) => {
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  return r.text;
};
/** Lines that differ between two texts of the same line count. */
const changed = (a: string, b: string) => {
  const x = a.split('\n'), y = b.split('\n');
  expect(y.length).toBe(x.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [i + 1]));
};

describe('editFrontmatter: set', () => {
  it('set keeps quoting and comments', () => {
    const a = ok(editFrontmatter(FM, { op: 'set', key: 'confidence', value: 'medium' }));
    expect(a.split('\n')[4]).toBe("confidence: 'medium' # why: two sources agree");
    expect(changed(FM, a)).toEqual([5]);
    const b = ok(editFrontmatter(FM, { op: 'set', key: 'updated', value: '2026-10-04' }));
    expect(b.split('\n')[3]).toBe('updated: 2026-10-04');
    expect(changed(FM, b)).toEqual([4]);
    for (const v of ['true', '123', 'null', 'a: b', '#x', '[x]']) {
      const t = ok(editFrontmatter('title: x', { op: 'set', key: 'title', value: v }));
      expect(t).toBe(`title: ${JSON.stringify(v)}`);
      expect(readFrontmatter(`---\n${t}\n---\n`)!.props[0]!.value).toBe(v);
    }
    // Found by the property tests: a value that would read as an alias is quoted.
    expect(ok(editFrontmatter('title: x', { op: 'set', key: 'title', value: '*a' }))).toBe('title: "*a"');
  });
});

describe('editFrontmatter: empty value and new key', () => {
  it('empty value and new key', () => {
    const a = ok(editFrontmatter(FM, { op: 'set', key: 'done', value: '2026-10-04' }));
    expect(a.split('\n').at(-1)).toBe('done: 2026-10-04');
    expect(changed(FM, a)).toEqual([17]);
    const b = ok(editFrontmatter(FM, { op: 'addKey', key: 'level', value: 'low' }));
    expect(b).toBe(`${FM}\nlevel: low`);
    expect(ok(editFrontmatter('type: x', { op: 'addKey', key: 'tags', value: ['a', 'b'] }))).toBe('type: x\ntags: [a, b]');
    // Found by the property tests: blank lines at the end stay at the end.
    expect(ok(editFrontmatter('a: 1\n\n', { op: 'addKey', key: 'k', value: 'v' }))).toBe('a: 1\nk: v\n\n');
    expect(editFrontmatter(FM, { op: 'addKey', key: 'type', value: 'x' })).toHaveProperty('refused');
    expect(ok(editFrontmatter('done: # later\nx: 1', { op: 'set', key: 'done', value: 'yes' }))).toBe('done: yes # later\nx: 1');
  });
});

describe('editFrontmatter: list items', () => {
  const add = (text: string, key: string, item: string, rules?: Rules) => ok(editFrontmatter(text, { op: 'add', key, item }, rules));
  const remove = (text: string, key: string, index: number) => ok(editFrontmatter(text, { op: 'remove', key, index }));

  it('list items', () => {
    expect(add('related: ["[[openai]]"]', 'related', 'tesla')).toBe('related: ["[[openai]]", "[[tesla]]"]');
    expect(add('related: [dolomites]', 'related', 'tesla')).toBe('related: [dolomites, tesla]');
    expect(add('sources: [a.md, b.md]', 'sources', 'foo')).toBe('sources: [a.md, b.md, foo.md]');
    expect(add('related: []', 'related', 'x', { related: { kind: 'links' } })).toBe('related: ["[[x]]"]');
    expect(add('tags: []', 'tags', 'x')).toBe('tags: [x]');
    const block = 'sources:\n  - "[[a]]"   # c\n  - \'[[b]]\'\nnext: 1';
    expect(add(block, 'sources', 'c')).toBe('sources:\n  - "[[a]]"   # c\n  - \'[[b]]\'\n  - "[[c]]"\nnext: 1');

    const flow = 'x: 0\nrelated: [a, "b", c] # k\ny: 1';
    expect(remove(flow, 'related', 0)).toBe('x: 0\nrelated: ["b", c] # k\ny: 1');
    expect(remove(flow, 'related', 1)).toBe('x: 0\nrelated: [a, c] # k\ny: 1');
    expect(remove(flow, 'related', 2)).toBe('x: 0\nrelated: [a, "b"] # k\ny: 1');
    expect(remove('related: [a]', 'related', 0)).toBe('related: []');
    const three = 'tags:\n  - a  # first\n  - b\n  - c\ny: 1';
    expect(remove(three, 'tags', 0)).toBe('tags:\n  - b\n  - c\ny: 1');
    expect(remove(three, 'tags', 1)).toBe('tags:\n  - a  # first\n  - c\ny: 1');
    expect(remove(three, 'tags', 2)).toBe('tags:\n  - a  # first\n  - b\ny: 1');
    expect(remove('tags:\n  - a\n  - b', 'tags', 1)).toBe('tags:\n  - a');
    expect(remove('tags:\n  - a\ny: 1', 'tags', 0)).toBe('tags: []\ny: 1');
  });
});

describe('checkEdit', () => {
  it('invariant', () => {
    const edit = { op: 'set', key: 'confidence', value: 'medium' } as const;
    const good = FM.replace("confidence: 'high'", "confidence: 'medium'");
    expect(checkEdit(FM, good, edit)).toBeNull();
    const bad = {
      'a changed comment on another line': good.replace('# the first one', '# the 1st one'),
      're-ordered keys': good.replace('type: synthesis\ntags: [llm, wiki]', 'tags: [llm, wiki]\ntype: synthesis'),
      'a re-quoted other value': good.replace('"Props: a test"', "'Props: a test'"),
      'a parse error': good.replace('tags: [llm, wiki]', 'tags: [llm, wiki'),
      'a value that reads back different': FM.replace("confidence: 'high'", "confidence: 'low'"),
      'an extra blank line': good.replace('\nrelated:', '\n\nrelated:'),
      'an extra line break at the end': `${good}\n`,
    };
    for (const [what, after] of Object.entries(bad)) expect(checkEdit(FM, after, edit), what).toEqual(expect.any(String));
    // A flow list over two lines can't be spliced safely.
    expect(editFrontmatter('x: [a,\n  b]', { op: 'add', key: 'x', item: 'c' })).toEqual({ refused: expect.any(String) });
  });
});

describe('demo vault corpus', () => {
  it('demo vault corpus', () => {
    const pages = readFileSync(new URL('./fixtures/wiki-frontmatter.txt', import.meta.url), 'utf8').replace(/\n$/, '').split('\n<<<<< next page >>>>>\n');
    expect(pages.length).toBeGreaterThan(100);
    let edits = 0;
    for (const fm of pages) {
      const r = readFrontmatter(`---\n${fm}\n---\n`)!;
      expect(r.error, fm).toBeUndefined();
      for (const p of r.props.filter((x) => x.editable)) {
        if (Array.isArray(p.value)) {
          const a = ok(editFrontmatter(fm, { op: 'add', key: p.key, item: 'zz-new' }));
          expect(ok(editFrontmatter(a, { op: 'remove', key: p.key, index: p.value.length })), `${p.key} in\n${fm}`).toBe(fm);
        } else if (p.value !== null) {
          const v = p.value as string | number | boolean;
          const next = typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : `${v}-new`;
          const a = ok(editFrontmatter(fm, { op: 'set', key: p.key, value: next }));
          expect(ok(editFrontmatter(a, { op: 'set', key: p.key, value: v })), `${p.key} in\n${fm}`).toBe(fm);
        } else continue;
        edits++;
      }
    }
    expect(edits).toBeGreaterThan(500);
  }, 60_000); // ~1,000 edits, each parsed several times
});

describe('review fixes', () => {
  it('keys that print the same are unreadable, not edited by name', () => {
    for (const fm of ['1: a\n"1": b', 'true: a\n"true": b', '? [a]\n: x\n? [b]\n: y']) {
      expect(readFrontmatter(`---\n${fm}\n---\n`)!.error, fm).toBeTruthy();
      expect(editFrontmatter(fm, { op: 'set', key: '1', value: 'c' })).toHaveProperty('refused');
    }
  });

  it('an empty value takes its first list item', () => {
    expect(ok(editFrontmatter('tags:\nx: 1', { op: 'add', key: 'tags', item: 'a' }))).toBe('tags: [a]\nx: 1');
    expect(ok(editFrontmatter('related: # later', { op: 'add', key: 'related', item: 'x' }, { related: { kind: 'links' } }))).toBe('related: ["[[x]]"] # later');
  });

  it('keys named like Object members get no rule from the prototype', () => {
    expect(readFrontmatter('---\ntoString: true\nconstructor: 3\n---\n', {})!.props.map((p) => p.kind)).toEqual(['boolean', 'number']);
  });
});
