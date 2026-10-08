import fc from 'fast-check';
import { Composer, CST, isMap, isScalar, Parser, type Scalar } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkEdit, editFrontmatter, readFrontmatter, type Edit, type Prop } from './frontmatter';

// Property-based round trips of form edits (note-outline-properties, architecture "Testing").

const RUNS = { numRuns: 1000 };
const SLOW = 60_000; // 1,000 runs with a YAML parse per step take longer than vitest's default

// ---------- generators: a frontmatter built from parts ----------

const word = fc.stringMatching(/^[a-zäöé][a-z0-9äöé_-]{0,8}$/).filter((w) => !['null', 'true', 'false'].includes(w));
const text = fc.string({ unit: fc.constantFrom(...'abc xyzÄé#:\'"-[]{},&*!|>%@`'.split('')), maxLength: 20 });
const single = (s: string) => `'${s.replace(/'/g, "''")}'`;

const scalar = fc.oneof(
  word,
  text.map(single),
  text.map((s) => JSON.stringify(s)),
  fc.integer({ min: -999, max: 9999 }).map(String),
  fc.boolean().map(String),
  fc.integer({ min: 1, max: 28 }).map((d) => `2026-10-${String(d).padStart(2, '0')}`),
);
const item = fc.oneof(word, word.map((w) => `"[[${w}]]"`), word.map((w) => `'[[${w}]]'`), word.map((w) => `${w}.md`), text.map((s) => JSON.stringify(s)));
const comment = fc.oneof(fc.constant(''), fc.constantFrom('  # c', ' # why: x', '   #')); // trailing comment or none

const value = fc.oneof(
  fc.tuple(scalar, comment).map(([s, c]) => `${s}${c}`),
  fc.tuple(fc.array(item, { maxLength: 4 }), fc.constantFrom(', ', ',', ' , '), comment).map(([xs, sep, c]) => `[${xs.join(sep)}]${c}`),
  fc.tuple(fc.array(fc.tuple(item, comment), { minLength: 1, maxLength: 4 }), fc.constantFrom('  ', '', '    '))
    .map(([xs, ind]) => xs.map(([x, c]) => `\n${ind}- ${x}${c}`).join('')),
  fc.constant('|\n  first line\n  second line'),
  fc.constant(''),
);
const gap = fc.constantFrom('', '', '', '\n', '\n# a comment', '\n\n');

const frontmatter = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z_]{0,6}$/), { minLength: 1, maxLength: 6 }).chain((keys) =>
  fc.tuple(fc.constantFrom('', '# head\n'), ...keys.map((k) => fc.tuple(value, gap, fc.constantFrom(' ', '   ')).map(([v, g, sp]) => `${k}:${v && !v.startsWith('\n') ? sp : ''}${v}${g}`)))
    .map(([head, ...pairs]) => head + pairs.join('\n')))
  .filter((fm) => { const r = readFrontmatter(`---\n${fm}\n---\n`); return !!r && !r.error; });

// ---------- edits on a generated frontmatter ----------

const note = (fm: string) => `---\n${fm}\n---\n`;
const props = (fm: string) => readFrontmatter(note(fm))!.props;
const lists = (ps: Prop[]) => ps.filter((p) => p.editable && Array.isArray(p.value));
const scalars = (ps: Prop[]) => ps.filter((p) => p.editable && !Array.isArray(p.value));
const newValue = fc.oneof(word, text.filter((s) => s.trim() === s && s !== ''), fc.integer({ min: 0, max: 99 }), fc.boolean());

const edit = (fm: string) => {
  const ps = props(fm);
  const opts: fc.Arbitrary<Edit>[] = [fc.stringMatching(/^[a-z]{1,8}$/).filter((k) => !ps.some((p) => p.key === k)).map((key) => ({ op: 'addKey' as const, key, value: 'v' }))];
  if (scalars(ps).length) opts.push(fc.tuple(fc.constantFrom(...scalars(ps)), newValue).map(([p, value]) => ({ op: 'set' as const, key: p.key, value })));
  if (lists(ps).length) opts.push(fc.tuple(fc.constantFrom(...lists(ps)), word).map(([p, item]) => ({ op: 'add' as const, key: p.key, item })));
  const nonEmpty = lists(ps).filter((p) => (p.value as unknown[]).length);
  if (nonEmpty.length) opts.push(fc.constantFrom(...nonEmpty).chain((p) => fc.nat((p.value as unknown[]).length - 1).map((index) => ({ op: 'remove' as const, key: p.key, index }))));
  return fc.oneof(...opts);
};
const withEdit = frontmatter.chain((fm) => edit(fm).map((e) => ({ fm, e })));

/** The scalar style (`PLAIN`, `QUOTE_SINGLE`, `QUOTE_DOUBLE`) of `key`'s value. */
function styleOf(fm: string, key: string) {
  const doc = [...new Composer().compose(new Parser().parse(fm))][0]!;
  const p = isMap(doc.contents) ? doc.contents.items.find((x) => isScalar(x.key) && String(x.key.value) === key) : undefined;
  return (p?.value as Scalar | undefined)?.type;
}

describe('frontmatter edits (property-based)', () => {
  it('parse → CST.stringify is the identity', () => {
    fc.assert(fc.property(frontmatter, (fm) => [...new Parser().parse(fm)].map((t) => CST.stringify(t)).join('') === fm), RUNS);
  });

  it('every edit is refused, or keeps the invariant and every other property', () => {
    fc.assert(fc.property(withEdit, ({ fm, e }) => {
      const r = editFrontmatter(fm, e);
      if ('refused' in r) return;
      expect(checkEdit(fm, r.text, e)).toBeNull();
      const others = (t: string) => props(t).filter((p) => p.key !== e.key).map((p) => [p.key, p.value]);
      expect(others(r.text)).toEqual(others(fm));
    }), RUNS);
  }, SLOW);

  it('set, then set back: byte-identical when the original style holds the new value', () => {
    const arb = frontmatter.filter((fm) => scalars(props(fm)).some((p) => p.value !== null))
      .chain((fm) => fc.tuple(fc.constant(fm), fc.constantFrom(...scalars(props(fm)).filter((p) => p.value !== null)), newValue));
    fc.assert(fc.property(arb, ([fm, p, v]) => {
      const a = editFrontmatter(fm, { op: 'set', key: p.key, value: v });
      if ('refused' in a || styleOf(a.text, p.key) !== styleOf(fm, p.key)) return;
      expect(editFrontmatter(a.text, { op: 'set', key: p.key, value: p.value as string | number | boolean })).toEqual({ text: fm });
    }), RUNS);
  }, SLOW);

  it('add, then remove the same item: byte-identical', () => {
    const arb = frontmatter.filter((fm) => lists(props(fm)).length > 0).chain((fm) => fc.tuple(fc.constant(fm), fc.constantFrom(...lists(props(fm))), word));
    fc.assert(fc.property(arb, ([fm, p, item]) => {
      const a = editFrontmatter(fm, { op: 'add', key: p.key, item });
      if ('refused' in a) return;
      expect(editFrontmatter(a.text, { op: 'remove', key: p.key, index: (p.value as unknown[]).length })).toEqual({ text: fm });
    }), RUNS);
  }, SLOW);

  it('refusals stay under 5 % of edits on editable values', () => {
    const cases = fc.sample(withEdit, 1000);
    const refused = cases.filter(({ fm, e }) => 'refused' in editFrontmatter(fm, e));
    expect(refused.length / cases.length, JSON.stringify(refused.slice(0, 3))).toBeLessThan(0.05);
  }, SLOW);
});
