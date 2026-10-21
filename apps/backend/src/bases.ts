// Bases-compatible query tables (#91): a subset of Obsidian Bases syntax (https://obsidian.md/help/bases/syntax),
// evaluated over an index of the vault's files and their frontmatter. Read-only: nothing here writes.
// What v1 doesn't understand is refused with a BaseError ("… is not supported in v1"), never guessed.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { linkRefs, resolveLinkRefs, resolveWikilink, type BaseCell, type BaseResult, type LinkRef } from '@karpathy/shared';
import { listTree } from './files.js';

export class BaseError extends Error {
  constructor(message: string, readonly code: 'base-invalid' | 'base-unsupported') {
    super(message);
  }
}
const unsupported = (what: string) => new BaseError(`${what} not supported in v1`, 'base-unsupported');
const invalid = (what: string) => new BaseError(what, 'base-invalid');

/** Rows shown at most, whatever the view's `limit` says (the table must stay usable on a phone). */
export const MAX_ROWS = 500;

// ---------- the file index ----------

interface FileRec {
  path: string;
  size: number;
  mtime: Date;
  ctime: Date;
  /** Frontmatter of a Markdown note (empty for other files or unreadable YAML). */
  props: Record<string, unknown>;
  /** Frontmatter and inline tags, without `#`. */
  tags: string[];
  /** The note's links as written (Markdown only), for `file.links` / `file.hasLink`; resolved per query. */
  refs: LinkRef[];
}

/** Per vault root: each file's record, re-read only when its size or mtime changed. */
const indexes = new Map<string, Map<string, { key: string; rec: FileRec }>>();

/** Drops the cached index of a vault root (vault removed, root changed). The next query rebuilds it. */
export function forgetBaseIndex(root: string): void {
  indexes.delete(root);
}

/** Vault roots with a cached index (for tests). */
export const baseIndexRoots = (): string[] => [...indexes.keys()];

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterOf(text: string): { props: Record<string, unknown>; body: string } {
  const m = FM_RE.exec(text);
  if (!m) return { props: {}, body: text };
  let props: unknown = null;
  try {
    props = parseYaml(m[1]!, { schema: 'core' });
  } catch {
    // Unreadable frontmatter: the note still counts, with no properties.
  }
  return { props: props && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

const INLINE_TAG = /(?:^|[\s(,;])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function tagsOf(props: Record<string, unknown>, body: string): string[] {
  const out: string[] = [];
  for (const key of ['tags', 'tag']) {
    const v = props[key];
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
    for (const t of list) if (typeof t === 'string' && t.replace(/^#/, '')) out.push(t.replace(/^#/, ''));
  }
  // Inline tags, not in code.
  const prose = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, ' ');
  for (const m of prose.matchAll(INLINE_TAG)) out.push(m[1]!);
  return [...new Set(out)];
}

async function readRec(abs: string, path: string): Promise<{ key: string; rec: FileRec } | null> {
  const st = await stat(abs).catch(() => null);
  if (!st) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  let text = '';
  if (/\.md$/i.test(path)) text = await readFile(abs, 'utf8').catch(() => '');
  const { props, body } = frontmatterOf(text);
  return { key, rec: { path, size: st.size, mtime: st.mtime, ctime: st.birthtimeMs > 0 ? st.birthtime : st.ctime, props, tags: text ? tagsOf(props, body) : [], refs: text ? linkRefs(text) : [] } };
}

/** Every vault file (dot folders hidden, as in the file tree) with its frontmatter; unchanged files come from the cache. */
async function indexVault(root: string): Promise<FileRec[]> {
  const cache = indexes.get(root) ?? new Map<string, { key: string; rec: FileRec }>();
  indexes.set(root, cache);
  const paths = (await listTree(root)).filter((f) => f.type === 'file').map((f) => f.path);
  const seen = new Set(paths);
  for (const p of cache.keys()) if (!seen.has(p)) cache.delete(p);
  const out: FileRec[] = [];
  for (let i = 0; i < paths.length; i += 64) {
    const batch = await Promise.all(paths.slice(i, i + 64).map(async (path) => {
      const abs = join(root, path);
      const st = await stat(abs).catch(() => null);
      if (!st) return null; // deleted since the listing
      const hit = cache.get(path);
      if (hit && hit.key === `${st.size}:${st.mtimeMs}`) return hit.rec;
      const fresh = await readRec(abs, path);
      if (fresh) cache.set(path, fresh);
      return fresh?.rec ?? null;
    }));
    for (const r of batch) if (r) out.push(r);
  }
  return out;
}

// ---------- expressions ----------

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Node; name: string }
  | { k: 'index'; obj: Node; idx: Node }
  | { k: 'call'; callee: Node; args: Node[] }
  | { k: 'list'; items: Node[] }
  | { k: 'unary'; op: '!' | '-'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

const OPS = ['==', '!=', '>=', '<=', '&&', '||', '>', '<', '!', '+', '-', '*', '/', '%', '(', ')', '[', ']', ',', '.'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let s = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) s += src[j] === '\\' && j + 1 < src.length ? src[++j] : src[j];
      if (j >= src.length) throw invalid(`Unclosed text in \`${src}\``);
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw invalid(`Can't read \`${c}\` in \`${src}\``);
    // A `/` where a value should start is a regular expression literal.
    if (op === '/') {
      const prev = out[out.length - 1];
      if (!prev || (prev.t === 'op' && prev.v !== ')' && prev.v !== ']')) throw unsupported('Regular expressions are');
    }
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

/** How deep an expression (or a filter tree) may nest; deeper is refused instead of overflowing the stack. */
export const MAX_DEPTH = 256;
const tooDeep = () => invalid(`Expression nested too deeply (more than ${MAX_DEPTH} levels)`);

const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

/** Parses one Bases expression (Pratt parser). */
export function parseExpr(src: string): Node {
  const toks = lex(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw invalid(`Expected \`${v}\` in \`${src}\``);
    p++;
  };
  const args = (close: string): Node[] => {
    const out: Node[] = [];
    if (isOp(close)) { p++; return out; }
    for (;;) {
      out.push(expr(0));
      if (isOp(',')) { p++; continue; }
      expect(close);
      return out;
    }
  };
  const primary = (): Node => {
    if (++depth > MAX_DEPTH) throw tooDeep();
    try {
      return primaryAt();
    } finally {
      depth--;
    }
  };
  const primaryAt = (): Node => {
    const t = toks[p++];
    if (!t) throw invalid(`Unexpected end of \`${src}\``);
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'id', name: t.v };
    }
    if (t.v === '(') { const e = expr(0); expect(')'); return e; }
    if (t.v === '[') return { k: 'list', items: args(']') };
    if (t.v === '!' || t.v === '-') return { k: 'unary', op: t.v, a: postfix(primary()) };
    throw invalid(`Unexpected \`${t.v}\` in \`${src}\``);
  };
  const postfix = (n: Node): Node => {
    for (;;) {
      if (isOp('.')) {
        p++;
        const t = toks[p++];
        if (!t || t.t !== 'id') throw invalid(`Expected a name after \`.\` in \`${src}\``);
        n = { k: 'member', obj: n, name: t.v };
      } else if (isOp('(')) { p++; n = { k: 'call', callee: n, args: args(')') }; }
      else if (isOp('[')) { p++; const idx = expr(0); expect(']'); n = { k: 'index', obj: n, idx }; }
      else return n;
    }
  };
  const expr = (min: number): Node => {
    let left = postfix(primary());
    for (;;) {
      const t = peek();
      const prec = t?.t === 'op' ? PREC[t.v] : undefined;
      if (prec === undefined || prec <= min) return left;
      p++;
      left = { k: 'bin', op: String(t!.v), a: left, b: expr(prec) };
    }
  };
  if (!toks.length) throw invalid('Empty filter');
  const e = expr(0);
  if (p < toks.length) throw invalid(`Unexpected \`${(toks[p] as { v: unknown }).v}\` in \`${src}\``);
  check(e);
  return e;
}

const GLOBALS = new Set(['date', 'today', 'now', 'list', 'number', 'if', 'max', 'min']);
const FILE_FIELDS = new Set(['name', 'basename', 'path', 'folder', 'ext', 'size', 'ctime', 'mtime', 'tags', 'links', 'properties', 'file']);
const FILE_FNS = new Set(['inFolder', 'hasTag', 'hasProperty', 'hasLink']);
const METHODS = new Set(['contains', 'containsAll', 'containsAny', 'startsWith', 'endsWith', 'isEmpty', 'lower', 'upper', 'trim', 'toString', 'isTruthy', 'date']);

/** Refuses what v1 can't evaluate (or nests too deeply to evaluate), before any file is looked at. */
function check(n: Node, depth = 0): void {
  if (depth > MAX_DEPTH) throw tooDeep();
  const sub = (x: Node) => check(x, depth + 1);
  switch (n.k) {
    case 'lit': return;
    case 'id':
      if (n.name === 'this') throw unsupported('`this` is');
      if (n.name === 'formula') throw unsupported('Formulas are');
      return;
    case 'member':
      if (n.obj.k === 'id' && n.obj.name === 'file' && !FILE_FIELDS.has(n.name) && !FILE_FNS.has(n.name)) throw unsupported(`\`file.${n.name}\` is`);
      return sub(n.obj);
    case 'index': sub(n.obj); return sub(n.idx);
    case 'list': return n.items.forEach(sub);
    case 'unary': return sub(n.a);
    case 'bin': sub(n.a); return sub(n.b);
    case 'call': {
      const c = n.callee;
      if (c.k === 'id') { if (!GLOBALS.has(c.name)) throw unsupported(`The function \`${c.name}()\` is`); }
      else if (c.k === 'member') {
        const onFile = c.obj.k === 'id' && c.obj.name === 'file';
        if (onFile ? !FILE_FNS.has(c.name) : !METHODS.has(c.name)) throw unsupported(`\`${onFile ? 'file.' : '.'}${c.name}()\` is`);
        sub(c.obj);
      } else throw invalid('Only functions can be called');
      return n.args.forEach(sub);
    }
  }
}

// ---------- values ----------

/** The `file` object of the row being evaluated. */
class FileVal {
  constructor(readonly rec: FileRec) {}
}
/** The `note` namespace (frontmatter). */
class NoteVal {
  constructor(readonly props: Record<string, unknown>) {}
}

interface Ctx {
  rec: FileRec;
  paths: readonly string[];
  now: Date;
  links: () => string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' && DATE_RE.test(v.trim())) {
    const s = v.trim();
    // Date-only and zone-less times count as UTC (the server's clock), as `today()` does.
    const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : /Z|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const UNITS: Record<string, string> = {
  y: 'y', year: 'y', years: 'y', M: 'M', month: 'M', months: 'M', d: 'd', day: 'd', days: 'd', w: 'w', week: 'w', weeks: 'w',
  h: 'h', hour: 'h', hours: 'h', m: 'm', minute: 'm', minutes: 'm', s: 's', second: 's', seconds: 's',
};
/** `date` moved by a duration text like `"1 month"` or `"2h"`; null when the text isn't a duration. */
function shift(date: Date, dur: string, sign: 1 | -1): Date | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(dur);
  const unit = m && UNITS[m[2]!];
  if (!m || !unit) return null;
  const n = Number(m[1]) * sign;
  const d = new Date(date.getTime());
  if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() + n);
  else if (unit === 'M') d.setUTCMonth(d.getUTCMonth() + n);
  else d.setTime(d.getTime() + n * { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit as 'w']!);
  return d;
}

/** A key's own value (null when missing): never an inherited member like `constructor` or `__proto__`. */
const own = (o: object, key: string): unknown => (Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] ?? null : null);

const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v instanceof Date ? true : !!v);

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof FileVal || b instanceof FileVal) return a instanceof FileVal && b instanceof FileVal && a.rec.path === b.rec.path;
  if (a instanceof Date || b instanceof Date) {
    const x = toDate(a);
    const y = toDate(b);
    return !!x && !!y && x.getTime() === y.getTime();
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return (a ?? null) === (b ?? null);
}

/** <0, 0, >0, or null when the two can't be ordered. */
function order(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date || b instanceof Date) {
    const x = toDate(a);
    const y = toDate(b);
    return x && y ? x.getTime() - y.getTime() : null;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

const text = (v: unknown): string => (v == null ? '' : v instanceof Date ? dateText(v) : Array.isArray(v) ? v.map(text).join(', ') : v instanceof FileVal ? v.rec.path : typeof v === 'object' ? JSON.stringify(v) : String(v));

function fileField(rec: FileRec, name: string, ctx: Ctx): unknown {
  const base = rec.path.split('/').pop()!;
  const dot = base.lastIndexOf('.');
  switch (name) {
    case 'name': return base;
    case 'basename': return dot > 0 ? base.slice(0, dot) : base;
    case 'path': return rec.path;
    case 'folder': return rec.path.includes('/') ? rec.path.slice(0, rec.path.lastIndexOf('/')) : '/';
    case 'ext': return dot > 0 ? base.slice(dot + 1) : '';
    case 'size': return rec.size;
    case 'ctime': return rec.ctime;
    case 'mtime': return rec.mtime;
    case 'tags': return rec.tags;
    case 'links': return ctx.links();
    case 'properties': return rec.props;
    case 'file': return new FileVal(rec);
    default: return null;
  }
}

function fileFn(rec: FileRec, name: string, args: unknown[], ctx: Ctx): boolean {
  switch (name) {
    case 'inFolder': {
      const f = text(args[0]).replace(/^\/+|\/+$/g, '');
      return !f || rec.path.startsWith(`${f}/`);
    }
    case 'hasTag': return args.some((a) => {
      const t = text(a).replace(/^#/, '').toLowerCase();
      return rec.tags.some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(`${t}/`));
    });
    case 'hasProperty': return Object.hasOwn(rec.props, text(args[0]));
    case 'hasLink': {
      const a = args[0];
      const target = a instanceof FileVal ? a.rec.path : resolveWikilink(text(a), ctx.paths, rec.path) ?? text(a);
      return ctx.links().includes(target);
    }
    default: return false;
  }
}

function method(v: unknown, name: string, args: unknown[]): unknown {
  const list = Array.isArray(v);
  const has = (x: unknown) => (list ? (v as unknown[]).some((y) => eq(y, x)) : text(v).includes(text(x)));
  switch (name) {
    case 'contains': return has(args[0]);
    case 'containsAll': return args.every(has);
    case 'containsAny': return args.some(has);
    case 'startsWith': return typeof v === 'string' && v.startsWith(text(args[0]));
    case 'endsWith': return typeof v === 'string' && v.endsWith(text(args[0]));
    case 'isEmpty': return v == null || v === '' || (list && !(v as unknown[]).length) || (typeof v === 'object' && !list && !(v instanceof Date) && !Object.keys(v as object).length);
    case 'lower': return text(v).toLowerCase();
    case 'upper': return text(v).toUpperCase();
    case 'trim': return text(v).trim();
    case 'toString': return text(v);
    case 'isTruthy': return truthy(v);
    case 'date': {
      const d = toDate(v);
      return d && new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    default: return null;
  }
}

function evaluate(n: Node, ctx: Ctx): unknown {
  switch (n.k) {
    case 'lit': return n.v;
    case 'list': return n.items.map((x) => evaluate(x, ctx));
    case 'id':
      if (n.name === 'file') return new FileVal(ctx.rec);
      if (n.name === 'note') return new NoteVal(ctx.rec.props);
      return own(ctx.rec.props, n.name);
    case 'member': {
      const o = evaluate(n.obj, ctx);
      if (o instanceof FileVal) return fileField(o.rec, n.name, ctx);
      if (o instanceof NoteVal) return own(o.props, n.name);
      if (n.name === 'length' && (typeof o === 'string' || Array.isArray(o))) return o.length;
      if (o instanceof Date) {
        const f = { year: o.getUTCFullYear(), month: o.getUTCMonth() + 1, day: o.getUTCDate(), hour: o.getUTCHours(), minute: o.getUTCMinutes() } as Record<string, number>;
        return f[n.name] ?? null;
      }
      if (o && typeof o === 'object' && !Array.isArray(o)) return own(o, n.name);
      return null;
    }
    case 'index': {
      const o = evaluate(n.obj, ctx);
      const i = evaluate(n.idx, ctx);
      if (o instanceof NoteVal) return own(o.props, text(i));
      if (Array.isArray(o) && typeof i === 'number') return o[i] ?? null;
      if (o && typeof o === 'object' && !(o instanceof Date)) return own(o, text(i));
      return null;
    }
    case 'call': {
      const args = n.args.map((x) => evaluate(x, ctx));
      const c = n.callee;
      if (c.k === 'id') {
        const today = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), ctx.now.getUTCDate()));
        switch (c.name) {
          case 'date': return toDate(args[0]);
          case 'today': return today;
          case 'now': return ctx.now;
          case 'list': return Array.isArray(args[0]) ? args[0] : args[0] == null ? [] : [args[0]];
          case 'number': { const x = Number(args[0] instanceof Date ? args[0].getTime() : args[0]); return Number.isNaN(x) ? null : x; }
          case 'if': return truthy(args[0]) ? args[1] ?? null : args[2] ?? null;
          case 'max': case 'min': {
            const nums = args.filter((x): x is number => typeof x === 'number');
            return nums.length ? Math[c.name](...nums) : null;
          }
        }
        return null;
      }
      if (c.k !== 'member') return null;
      const o = evaluate(c.obj, ctx);
      if (o instanceof FileVal) return fileFn(o.rec, c.name, args, ctx);
      return method(o, c.name, args);
    }
    case 'unary': {
      const a = evaluate(n.a, ctx);
      return n.op === '!' ? !truthy(a) : typeof a === 'number' ? -a : null;
    }
    case 'bin': {
      if (n.op === '&&') return truthy(evaluate(n.a, ctx)) && truthy(evaluate(n.b, ctx));
      if (n.op === '||') return truthy(evaluate(n.a, ctx)) || truthy(evaluate(n.b, ctx));
      const a = evaluate(n.a, ctx);
      const b = evaluate(n.b, ctx);
      switch (n.op) {
        case '==': return eq(a, b);
        case '!=': return !eq(a, b);
        case '>': { const o = order(a, b); return o !== null && o > 0; }
        case '<': { const o = order(a, b); return o !== null && o < 0; }
        case '>=': { const o = order(a, b); return o !== null && o >= 0; }
        case '<=': { const o = order(a, b); return o !== null && o <= 0; }
        case '+': case '-': {
          const sign = n.op === '+' ? 1 : -1;
          if (typeof a === 'number' && typeof b === 'number') return a + sign * b;
          const da = a instanceof Date ? a : null;
          if (da && typeof b === 'string') return shift(da, b, sign);
          if (da && b instanceof Date && sign === -1) return da.getTime() - b.getTime();
          if (sign === 1 && (typeof a === 'string' || typeof b === 'string')) return text(a) + text(b);
          return null;
        }
        default: {
          if (typeof a !== 'number' || typeof b !== 'number') return null;
          return n.op === '*' ? a * b : n.op === '/' ? a / b : a % b;
        }
      }
    }
  }
}

// ---------- the base ----------

type Filter = { and: Filter[] } | { or: Filter[] } | { not: Filter[] } | { expr: Node };

function compileFilter(f: unknown, depth = 0): Filter {
  if (depth > MAX_DEPTH) throw invalid(`Filters nested too deeply (more than ${MAX_DEPTH} levels)`);
  if (typeof f === 'string') return { expr: parseExpr(f) };
  if (typeof f === 'boolean') return { expr: { k: 'lit', v: f } };
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const keys = Object.keys(f);
    const key = keys[0];
    if (keys.length === 1 && (key === 'and' || key === 'or' || key === 'not')) {
      const list = (f as Record<string, unknown>)[key];
      if (!Array.isArray(list)) throw invalid(`\`${key}\` needs a list of filters`);
      return { [key]: list.map((x) => compileFilter(x, depth + 1)) } as Filter;
    }
  }
  throw invalid(`A filter is a text or one of and / or / not, not ${JSON.stringify(f)}`);
}

function test(f: Filter, ctx: Ctx): boolean {
  if ('expr' in f) return truthy(evaluate(f.expr, ctx));
  if ('and' in f) return f.and.every((x) => test(x, ctx));
  if ('or' in f) return f.or.some((x) => test(x, ctx));
  return !f.not.some((x) => test(x, ctx));
}

/** A column or sort key: a file property (`file.x`) or a frontmatter key (`note.x` or plain). */
function propertyNode(id: string): Node {
  if (id.startsWith('formula.')) throw unsupported(`The formula column \`${id}\`: formulas are`);
  if (id.startsWith('file.')) {
    const name = id.slice(5);
    if (!FILE_FIELDS.has(name)) throw unsupported(`The column \`${id}\` is`);
    return { k: 'member', obj: { k: 'id', name: 'file' }, name };
  }
  return { k: 'index', obj: { k: 'id', name: 'note' }, idx: { k: 'lit', v: id.startsWith('note.') ? id.slice(5) : id } };
}

interface Parsed {
  filters: Filter[];
  view: string | null;
  columns: { id: string; label: string; node: Node }[];
  sort: { node: Node; desc: boolean }[];
  limit: number | null;
  notices: string[];
}

const asObject = (v: unknown, what: string): Record<string, unknown> => {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid(`${what} must be a map of keys`);
  return v as Record<string, unknown>;
};

export function parseBase(source: string): Parsed {
  let doc: unknown;
  try {
    doc = parseYaml(source, { schema: 'core' });
  } catch (e) {
    throw invalid(`Not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  const top = asObject(doc, 'A base');
  const notices: string[] = [];
  if (top.formulas != null && Object.keys(asObject(top.formulas, '`formulas`')).length) throw unsupported('Formulas are');
  if (top.summaries != null) notices.push('summaries are not supported in v1 and are left out');
  const views = top.views ?? [{ type: 'table' }];
  if (!Array.isArray(views) || !views.length) throw invalid('`views` must be a list of views');
  const view = asObject(views[0], 'A view');
  const type = view.type ?? 'table';
  if (type !== 'table') throw unsupported(`The view type \`${String(type)}\` is (only \`table\` is)`);
  if (views.length > 1) notices.push(`only the first view is shown (this base has ${views.length})`);
  for (const k of ['groupBy', 'summaries']) if (view[k] != null) notices.push(`${k} is not supported in v1 and is left out`);
  const filters = [top.filters, view.filters].filter((f) => f != null).map((f) => compileFilter(f));
  const props = asObject(top.properties, '`properties`');
  const label = (id: string) => {
    const plain = id.startsWith('note.') ? id.slice(5) : id;
    for (const k of [id, plain, `note.${plain}`]) {
      const spec = own(props, k);
      const name = spec && typeof spec === 'object' ? own(spec, 'displayName') : null;
      if (typeof name === 'string' || typeof name === 'number') return String(name);
    }
    return id.startsWith('file.') ? `file ${id.slice(5)}` : plain;
  };
  const order = view.order ?? ['file.name'];
  if (!Array.isArray(order) || order.some((c) => typeof c !== 'string')) throw invalid('`order` must be a list of property names');
  const columns = (order as string[]).map((id) => ({ id, label: label(id), node: propertyNode(id) }));
  const sortList = view.sort ?? [];
  if (!Array.isArray(sortList)) throw invalid('`sort` must be a list of { property, direction }');
  const sort = sortList.map((s) => {
    const o = asObject(s, 'A sort');
    if (typeof o.property !== 'string') throw invalid('A sort needs a `property`');
    const dir = String(o.direction ?? 'ASC').toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') throw invalid('A sort `direction` is ASC or DESC');
    return { node: propertyNode(o.property), desc: dir === 'DESC' };
  });
  let limit: number | null = null;
  if (view.limit != null) {
    if (typeof view.limit !== 'number' || !Number.isInteger(view.limit) || view.limit < 0) throw invalid('`limit` must be a whole number');
    limit = view.limit;
  }
  return { filters, view: typeof view.name === 'string' ? view.name : null, columns, sort, limit, notices };
}

function dateText(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function cell(v: unknown, id: string, rec: FileRec): BaseCell {
  if (id === 'file.name' || id === 'file.basename' || id === 'file.path') return { link: rec.path, text: text(v) };
  if (v == null) return null;
  if (v instanceof Date) return dateText(v);
  if (v instanceof FileVal) return { link: v.rec.path, text: v.rec.path };
  if (Array.isArray(v)) return v.map((x) => cell(x, '', rec));
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | boolean;
}

/** Sorts nulls and empty text last, whatever the direction. */
function sortCompare(a: unknown, b: unknown): number | 'empty-a' | 'empty-b' {
  const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && !v.length);
  if (empty(a) || empty(b)) return empty(a) && empty(b) ? 0 : empty(a) ? 'empty-a' : 'empty-b';
  const o = order(a, b);
  if (o !== null) return o;
  return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Runs a base block's source over the vault at `root`. */
export async function queryBase(root: string, source: string, opts: { now?: Date } = {}): Promise<BaseResult> {
  const base = parseBase(source);
  const recs = await indexVault(root);
  const paths = recs.map((r) => r.path);
  const now = opts.now ?? new Date();
  const rows: { rec: FileRec; ctx: Ctx }[] = [];
  for (const rec of recs) {
    let links: string[] | null = null;
    const ctx: Ctx = { rec, paths, now, links: () => (links ??= rec.refs.length ? resolveLinkRefs(rec.refs, rec.path, paths) : []) };
    if (base.filters.every((f) => test(f, ctx))) rows.push({ rec, ctx });
  }
  const keyed = rows.map((r) => ({ ...r, keys: base.sort.map((s) => evaluate(s.node, r.ctx)) }));
  keyed.sort((x, y) => {
    for (let i = 0; i < base.sort.length; i++) {
      const c = sortCompare(x.keys[i], y.keys[i]);
      if (c === 'empty-a') return 1;
      if (c === 'empty-b') return -1;
      if (c !== 0) return base.sort[i]!.desc ? -c : c;
    }
    return x.rec.path < y.rec.path ? -1 : x.rec.path > y.rec.path ? 1 : 0;
  });
  const total = keyed.length;
  const cap = Math.min(base.limit ?? MAX_ROWS, MAX_ROWS);
  const notices = [...base.notices];
  if (total > MAX_ROWS && (base.limit === null || base.limit > MAX_ROWS)) notices.push(`only the first ${MAX_ROWS} of ${total} rows are shown`);
  return {
    view: base.view,
    columns: base.columns.map(({ id, label }) => ({ id, label })),
    rows: keyed.slice(0, cap).map(({ rec, ctx }) => ({ path: rec.path, cells: base.columns.map((c) => cell(evaluate(c.node, ctx), c.id, rec)) })),
    total,
    notices,
  };
}
