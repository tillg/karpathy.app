// Note properties (#82): the frontmatter read through the `yaml` CST, so an edit can change the touched
// property's lines and keep every other byte (ADR 0003). `Document.toString()` is never used: it moves
// comments and re-styles scalars.
import { Composer, CST, type Document, isMap, isScalar, isSeq, type Node, type Pair, Parser, type Scalar } from 'yaml';
import { lineDiff } from './linediff';
import { splitFrontmatter } from './markdown';

export type PropertyKind = 'text' | 'enum' | 'date' | 'number' | 'boolean' | 'list' | 'links' | 'raw';
export type LinkStyle = 'wikilink' | 'bare';

/** What the frontmatter code needs from a schema rule (see `schema.ts`). */
export type Rules = Record<string, { kind: PropertyKind; linkStyle?: LinkStyle }>;

export interface Prop {
  key: string;
  /** `toJS()` of the value; null for an empty value (`key:`). */
  value: unknown;
  /** The schema rule's kind, else inferred from the value. */
  kind: PropertyKind;
  /** First and last line of the pair in the frontmatter text, 1-based. */
  lines: [number, number];
  /** List item style: `[[…]]` items or bare names, and whether bare items carry `.md`. */
  list?: { flow: boolean; style: LinkStyle; ext: boolean };
  /** False → shown read-only, "Edit in YAML". */
  editable: boolean;
}

/** `from`/`to`: the frontmatter text's offsets in the note. */
export interface Frontmatter { from: number; to: number; text: string; props: Prop[]; error?: string }

const SINGLE_LINE = new Set<string>(['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE']);

/** The frontmatter text parsed: its CST tokens and the document composed from them (nodes keep `srcToken`). */
export function parseFm(text: string) {
  const tokens = [...new Parser().parse(text)];
  const docs = [...new Composer({ keepSourceTokens: true }).compose(tokens)];
  const doc = docs[0] as Document.Parsed | undefined;
  let error: string | undefined;
  if (docs.length > 1) error = 'more than one document';
  else if (doc && (doc.errors.length || doc.warnings.length)) error = (doc.errors[0] ?? doc.warnings[0])!.message.split('\n')[0];
  else if (doc && doc.contents !== null && !isMap(doc.contents)) error = 'not a list of properties';
  else if (doc) {
    // Composes without errors but can't be read (an alias without its anchor).
    try { doc.toJS(); } catch (e) { error = (e as Error).message; }
  }
  return { tokens, doc, error };
}

/** A scalar the form can edit: one line, plain or quoted, no anchor or tag. */
export const simpleScalar = (n: unknown, text: string): n is Scalar =>
  isScalar(n) && !n.anchor && !n.tag && SINGLE_LINE.has(n.type ?? '') && !!n.range && !text.slice(n.range[0], n.range[1]).includes('\n');

/** The list's items, when every one is a simple scalar (else null). */
export function simpleItems(n: Node, text: string): Scalar[] | null {
  if (!isSeq(n) || n.anchor || n.tag) return null;
  if (!n.items.every((i) => simpleScalar(i, text))) return null;
  if (n.flow && text.slice(n.range![0], n.range![1]).includes('\n')) return null;
  return n.items as Scalar[];
}

/** 1-based line of offset `pos` in `text`. */
export const lineOf = (text: string, pos: number) => text.slice(0, pos).split('\n').length;

function inferKind(value: unknown, n: Node | null, text: string): PropertyKind {
  if (n === null || value === null) return 'text';
  if (isSeq(n)) {
    if (!simpleItems(n, text)) return 'raw';
    const items = value as unknown[];
    return items.length && items.every((i) => typeof i === 'string' && /^\[\[.*\]\]$/.test(i)) ? 'links' : 'list';
  }
  if (!simpleScalar(n, text)) return 'raw';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : 'text';
  return 'raw';
}

/** The frontmatter of a note (`\n` line breaks), or null when there is none. */
export function readFrontmatter(note: string, rules: Rules = {}): Frontmatter | null {
  const fm = splitFrontmatter(note).frontmatter;
  if (fm === null) return null;
  const from = note.indexOf('\n') + 1;
  return { from, to: from + fm.length, text: fm, ...parseProps(fm, rules) };
}

/** The properties of a frontmatter text (between the `---` lines). */
export function parseProps(fm: string, rules: Rules = {}): { props: Prop[]; error?: string } {
  const { doc, error } = parseFm(fm);
  if (error) return { props: [], error };
  const props: Prop[] = [];
  if (doc && isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      const k = pair.key as Node;
      const v = (pair.value as Node | null) ?? null;
      const key = isScalar(k) ? String(k.value) : '';
      const value = v === null ? null : v.toJS(doc);
      const end = v?.range && v.range[1] > v.range[0] ? v.range[1] - 1 : k.range![1] - 1;
      const keyOk = simpleScalar(k, fm);
      const editable = keyOk && (v === null || (isScalar(v) && v.value === null) || simpleScalar(v, fm) || !!simpleItems(v, fm));
      const rule = rules[key];
      // A rule's kind applies when the value's shape fits it (a scalar `tags: foo` stays text; validation flags it).
      const fits = rule && rule.kind !== 'raw' && (value === null || (rule.kind === 'list' || rule.kind === 'links') === Array.isArray(value));
      const kind = !editable ? 'raw' : fits ? rule.kind : inferKind(value, v, fm);
      const prop: Prop = { key, value, kind, lines: [lineOf(fm, k.range![0]), lineOf(fm, end)], editable };
      if (v && isSeq(v)) prop.list = listStyle(value as unknown[], !!v.flow, rule);
      props.push(prop);
    }
  }
  return { props };
}

/** A list's item style: any `[[…]]` item makes it `wikilink`; an empty link list takes the rule's style. */
function listStyle(items: unknown[], flow: boolean, rule?: Rules[string]): NonNullable<Prop['list']> {
  const strs = items.filter((i): i is string => typeof i === 'string');
  const empty: LinkStyle = rule?.kind === 'links' ? (rule.linkStyle ?? 'wikilink') : 'bare';
  const style: LinkStyle = strs.some((i) => i.startsWith('[[')) ? 'wikilink' : items.length ? 'bare' : empty;
  return { flow, style, ext: strs.some((i) => /\.md$/i.test(i)) };
}

export type Edit =
  | { op: 'set'; key: string; value: string | number | boolean }
  | { op: 'add'; key: string; item: string }
  | { op: 'remove'; key: string; index: number }
  | { op: 'addKey'; key: string; value: string | string[] };

export type EditResult = { text: string } | { refused: string };

const REFUSED = { refused: 'Edit this property in YAML' };

const pairOf = (doc: Document.Parsed | undefined, key: string) =>
  doc && isMap(doc.contents) ? (doc.contents.items as Pair<Node, Node | null>[]).find((p) => isScalar(p.key) && String(p.key.value) === key) : undefined;

/** The value of `key` after an edit, when `after` parses cleanly. */
function readBack(after: string, key: string): { value: unknown } | null {
  const { doc, error } = parseFm(after);
  const p = pairOf(doc, key);
  return error || !p ? null : { value: p.value ? p.value.toJS(doc!) : null };
}

/** `value` as YAML: plain when that reads back as `value` (inside a flow list when `flow`), else double-quoted. */
function fmt(value: string | number | boolean, flow = false): string {
  const plain = String(value);
  const back = (s: string) => { const r = readBack(`x: ${flow ? `[${s}]` : s}`, 'x'); return r && (flow ? (r.value as unknown[])[0] : r.value); };
  return plain && back(plain) === value && (!flow || (readBack(`x: [${plain}]`, 'x')?.value as unknown[]).length === 1) ? plain : JSON.stringify(plain);
}

/** `set` on an empty value (`key:`): the value is spliced in after the colon. */
function setEmpty(text: string, v: Node | null, k: Node, value: string | number | boolean): EditResult {
  const colon = text.indexOf(':', k.range![1]);
  const at = v?.range ? Math.max(colon + 1, v.range[0]) : colon + 1;
  if (colon < 0 || text.slice(colon + 1, at).trim()) return REFUSED;
  const rest = text.slice(colon + 1).replace(/^[ \t]*/, '');
  return { text: `${text.slice(0, colon + 1)} ${fmt(value)}${rest.startsWith('#') ? ' ' : ''}${rest}` };
}

/** `set` on a scalar: the token's value is replaced, in its own style when that reads back as `value`, else double-quoted. */
function setScalar(text: string, key: string, value: string | number | boolean): EditResult {
  const cur = pairOf(parseFm(text).doc, key)?.value;
  const types = [...new Set([isScalar(cur) ? cur.type : undefined, typeof value === 'string' ? 'QUOTE_DOUBLE' : 'PLAIN', 'QUOTE_DOUBLE'])];
  for (const type of types) {
    const { tokens, doc } = parseFm(text);
    const p = pairOf(doc, key);
    const v = p?.value ?? null;
    if (p && (v === null || (isScalar(v) && v.value === null && !v.srcToken))) {
      const r = setEmpty(text, v, p.key, value);
      return 'text' in r && readBack(r.text, key)?.value === value ? r : REFUSED;
    }
    if (!simpleScalar(v, text) || !v.srcToken) return REFUSED;
    CST.setScalarValue(v.srcToken as CST.FlowScalar, String(value), { type: type as Scalar.Type });
    const after = tokens.map((t) => CST.stringify(t)).join('');
    if (readBack(after, key)?.value === value) return { text: after };
  }
  return REFUSED;
}

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (text: string, pos: number) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };

/** `add`: a note name becomes `"[[name]]"` in a wikilink list, `name` (plus `.md` when the items carry it) in a bare one. */
function addItem(text: string, key: string, item: string, rules: Rules): EditResult {
  const { doc } = parseFm(text);
  const p = pairOf(doc, key);
  const seq = p?.value;
  const items = seq ? simpleItems(seq, text) : null;
  if (!p || !seq || !isSeq(seq) || !items) return REFUSED;
  const list = listStyle(seq.toJS(doc!) as unknown[], !!seq.flow, rules[key]);
  const value = list.style === 'wikilink' ? `[[${item.replace(/^\[\[(.*)\]\]$/, '$1')}]]` : list.ext && !/\.md$/i.test(item) ? `${item}.md` : item;
  const src = list.style === 'wikilink' ? JSON.stringify(value) : fmt(value, !!seq.flow);
  let after: string;
  if (seq.flow) {
    const at = items.length ? items.at(-1)!.range![1] : seq.range![0] + 1;
    after = `${text.slice(0, at)}${items.length ? ', ' : ''}${src}${text.slice(at)}`;
  } else {
    // A new line after the last item's line, with that line's indent and `- `.
    const last = items.at(-1)!;
    const prefix = text.slice(lineStart(text, last.range![0]), last.range![0]);
    const at = lineEnd(text, last.range![1]);
    after = `${text.slice(0, at)}\n${prefix}${src}${text.slice(at)}`;
  }
  return { text: after };
}

/** `remove`: a flow item with its separator; a block item with its whole line (and the comment on it). */
function removeItem(text: string, key: string, index: number): EditResult {
  const { doc } = parseFm(text);
  const p = pairOf(doc, key);
  const seq = p?.value;
  const items = seq ? simpleItems(seq, text) : null;
  if (!p || !seq || !isSeq(seq) || !items || !items[index]) return REFUSED;
  const it = items[index].range!;
  let after: string;
  if (seq.flow) {
    const [a, b] = index > 0 ? [items[index - 1]!.range![1], it[1]] : items.length > 1 ? [it[0], items[1]!.range![0]] : [it[0], it[1]];
    after = text.slice(0, a) + text.slice(b);
  } else if (items.length > 1) {
    const a = lineStart(text, it[0]);
    const b = lineEnd(text, it[1]);
    after = b < text.length ? text.slice(0, a) + text.slice(b + 1) : text.slice(0, a - 1);
  } else {
    // The only item: the list becomes `[]` on the key's line.
    const colon = text.indexOf(':', p.key.range![1]);
    const b = lineEnd(text, it[1]);
    if (text.slice(colon + 1, lineStart(text, it[0])).trim()) return REFUSED;
    after = `${text.slice(0, colon + 1)} []${text.slice(b)}`;
  }
  return { text: after };
}

function makeEdit(text: string, edit: Edit, rules: Rules): EditResult {
  if (edit.op === 'add') return addItem(text, edit.key, edit.item, rules);
  if (edit.op === 'remove') return removeItem(text, edit.key, edit.index);
  if (edit.op === 'set') return setScalar(text, edit.key, edit.value);
  if (pairOf(parseFm(text).doc, edit.key) || !/^\w([\w -]*\w)?$/.test(edit.key)) return REFUSED;
  const v = Array.isArray(edit.value) ? `[${edit.value.map((i) => fmt(i, true)).join(', ')}]` : fmt(edit.value);
  // After the last line with content: blank lines at the end stay at the end.
  const body = text.replace(/\n*$/, '');
  return { text: `${body}${body ? '\n' : ''}${edit.key}: ${v}${text.slice(body.length)}` };
}

/** The frontmatter text after `edit`, or why it was refused. Pure. `rules` give an empty link list its item style. */
export function editFrontmatter(text: string, edit: Edit, rules: Rules = {}): EditResult {
  if (parseFm(text).error) return REFUSED;
  const r = makeEdit(text, edit, rules);
  if ('refused' in r) return r;
  const why = checkEdit(text, r.text, edit, rules);
  return why ? { refused: why } : r;
}

/** The value the edited key should read back as after `edit` on `before`. */
function intended(before: string, edit: Edit, rules: Rules): unknown {
  if (edit.op === 'set' || edit.op === 'addKey') return edit.value;
  const { doc } = parseFm(before);
  const seq = pairOf(doc, edit.key)?.value;
  const items = (seq && isSeq(seq) ? seq.toJS(doc!) : []) as unknown[];
  if (edit.op === 'remove') return items.filter((_, i) => i !== edit.index);
  const list = listStyle(items, !!(seq && isSeq(seq) && seq.flow), rules[edit.key]);
  return [...items, list.style === 'wikilink' ? `[[${edit.item.replace(/^\[\[(.*)\]\]$/, '$1')}]]` : list.ext && !/\.md$/i.test(edit.item) ? `${edit.item}.md` : edit.item];
}

/**
 * The invariant every edit must keep, or why it doesn't (null = kept): `after` parses without errors, every
 * other property is unchanged and in its place, only the edited pair's lines changed (or the line right
 * after them; for `addKey` one appended line), and the edited key reads back as intended.
 */
export function checkEdit(before: string, after: string, edit: Edit, rules: Rules = {}): string | null {
  const a = parseFm(before);
  const b = parseFm(after);
  if (b.error) return `the result doesn't parse: ${b.error}`;
  const entries = (d: Document.Parsed | undefined) => (d && isMap(d.contents) ? (d.contents.items as Pair<Node, Node | null>[]).map((p) => [String((p.key as Scalar).value), p.value ? p.value.toJS(d) : null] as const) : []);
  const x = entries(a.doc).filter(([k]) => k !== edit.key);
  const y = entries(b.doc);
  const mine = y.find(([k]) => k === edit.key);
  if (JSON.stringify(x) !== JSON.stringify(y.filter(([k]) => k !== edit.key))) return 'another property would change';
  if (!mine || JSON.stringify(mine[1]) !== JSON.stringify(intended(before, edit, rules))) return `${edit.key} wouldn't read back as intended`;
  if (before.endsWith('\n') !== after.endsWith('\n')) return 'the last line break would change';
  // Lines: which lines of `before` go, and where lines come in.
  let span: [number, number];
  if (edit.op === 'addKey') {
    const body = before.replace(/\n*$/, '');
    span = [body ? body.split('\n').length + 1 : 1, Infinity];
  }
  else {
    const p = pairOf(a.doc, edit.key);
    if (!p) return `${edit.key} isn't there`;
    const v = p.value;
    const end = v?.range && v.range[1] > v.range[0] ? v.range[1] - 1 : p.key.range![1] - 1;
    span = [lineOf(before, p.key.range![0]), lineOf(before, end) + 1];
  }
  let line = 1;
  let added = 0;
  for (const d of lineDiff(before, after)) {
    if (d.op === 'eq') { line++; continue; }
    if (line < span[0] || line > span[1] || (d.op === 'theirs' && line === span[1] && edit.op !== 'addKey')) return 'lines outside the property would change';
    if (d.op === 'theirs') line++;
    else added++;
  }
  if (edit.op === 'addKey' && added !== 1) return 'more than one line would be added';
  return null;
}
