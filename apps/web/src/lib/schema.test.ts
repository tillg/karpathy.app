import { describe, expect, it } from 'vitest';
import { readFrontmatter } from './frontmatter';
import { applies, DEFAULT_SCHEMA, parseSchema, validate } from './schema';

describe('schema', () => {
  it('schema file and scope', () => {
    const file = { appliesTo: ['People/'], fields: { type: { kind: 'enum', values: ['person'], required: true }, related: { kind: 'links', linkStyle: 'bare' } } };
    expect(parseSchema(JSON.stringify(file))).toEqual(file);
    for (const bad of [
      { appliesTo: ['x/'], fields: { a: { kind: 'colour' } } },
      { appliesTo: ['x/'], fields: { a: { kind: 'text', values: ['a'] } } },
      { appliesTo: ['x/'], fields: { a: { kind: 'enum', values: [1] } } },
      { appliesTo: [3], fields: {} },
    ]) expect(parseSchema(JSON.stringify(bad)), JSON.stringify(bad)).toEqual({ error: expect.any(String) });
    expect(parseSchema('{ nope')).toEqual({ error: expect.any(String) });

    expect(applies(DEFAULT_SCHEMA, 'Wiki/a.md')).toBe(true);
    expect(applies(DEFAULT_SCHEMA, 'wiki/x/b.md')).toBe(true);
    expect(applies(DEFAULT_SCHEMA, 'Sources/a.md')).toBe(false);
    expect(applies(DEFAULT_SCHEMA, 'Wikis/a.md')).toBe(false);
  });
});

const TOUR = `type: entity
kind: tour
tags: [mountains, hike]
updated: 2026-10-02
activity: hike
region: wetterstein
start_m: 720
summit_m: 2962
aspect: mixed
glacier: false
difficulty: T4
best_months: [Jul, Aug, Sep]
done: 2023-08-15
sources: [2023-08-16-trip-report-zugspitze-reintal.md]
related: [wetterstein]`;

describe('validate', () => {
  const fm = (text: string) => readFrontmatter(`---\n${text}\n---\n`, DEFAULT_SCHEMA.fields)!;
  const flags = (text: string, path = 'Wiki/x.md') => validate(fm(text), DEFAULT_SCHEMA, path);
  const base = 'type: concept\ntags: [a]\nupdated: 2026-10-02';

  it('violations', () => {
    expect(flags(`${base}\nconfidence: very-high`)).toEqual([{ key: 'confidence', message: 'must be high, medium or low' }]);
    expect(flags('type: concept\ntags: [a]\nupdated: 2026-02-30')).toEqual([{ key: 'updated', message: 'not a date (YYYY-MM-DD)' }]);
    expect(flags('tags: [a]\nupdated: 2026-10-02')).toEqual([{ key: 'type', message: 'required on wiki pages' }]);
    expect(flags('type: concept\ntags: foo\nupdated: 2026-10-02')).toEqual([{ key: 'tags', message: 'should be a list' }]);
    expect(flags(`${base}\nrelated: [[[a]], "[[b]]"]`)).toEqual([{ key: 'related', index: 0, message: 'wikilinks in lists need quotes' }]);
    expect(flags(`${base}\nkind: tour\nsummit_m: 3606`)).toEqual([]);
    expect(flags(TOUR)).toEqual([]);
    expect(flags(`${base}\nconfidence: very-high`, 'Sources/x.md')).toEqual([]);
    expect(flags('a: 1\na: 2')).toEqual([{ key: '', message: expect.stringContaining('unique') }]);

    const f = fm(`${base}\nconfidence: very-high`);
    const copy = structuredClone(f);
    validate(f, DEFAULT_SCHEMA, 'Wiki/x.md');
    expect(f).toEqual(copy);
  });
});

describe('review fixes', () => {
  const fm = (text: string) => readFrontmatter(`---\n${text}\n---\n`, DEFAULT_SCHEMA.fields)!;
  const base = 'type: concept\ntags: [a]\nupdated: 2026-10-02';
  it('only an unquoted [[…]] is flagged, in any list', () => {
    expect(validate(fm(`${base}\nsee_also: [[[x]], y]`), DEFAULT_SCHEMA, 'Wiki/x.md')).toEqual([{ key: 'see_also', index: 0, message: 'wikilinks in lists need quotes' }]);
    expect(validate(fm(`${base}\nrelated:\n  - [a, b]`), DEFAULT_SCHEMA, 'Wiki/x.md')).toEqual([]);
  });
  it('appliesTo "" or "/" is the whole vault', () => {
    expect(applies({ appliesTo: [''], fields: {} }, 'a.md')).toBe(true);
    expect(applies({ appliesTo: ['/'], fields: {} }, 'x/a.md')).toBe(true);
  });
});

describe('wrong kind', () => {
  it('wrong kind', () => {
    const schema = { appliesTo: [''], fields: { n: { kind: 'number' as const }, b: { kind: 'boolean' as const }, t: { kind: 'text' as const } } };
    const flags = (text: string) => validate(readFrontmatter(`---\n${text}\n---\n`, schema.fields)!, schema, 'a.md');
    expect(flags('n: high\nb: yes\nt: [a]')).toEqual([
      { key: 'n', message: 'should be a number' },
      { key: 'b', message: 'should be true or false' },
      { key: 't', message: 'should be a single value' },
    ]);
    expect(flags('n: 3\nb: true\nt: x')).toEqual([]);
  });
});
