import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { stemmer as stemDe } from '@orama/stemmers/german';
import { stemmer as stemEn } from '@orama/stemmers/english';
import { stemmer as stemEs } from '@orama/stemmers/spanish';
import { stemmer as stemFr } from '@orama/stemmers/french';
import { stemmer as stemIt } from '@orama/stemmers/italian';
import { franc } from 'franc-min';
import MiniSearch, { type SearchResult } from 'minisearch';
import type { SearchHit } from '@karpathy/shared';
import { resolveInVault } from './paths.js';

/**
 * Ranked full-text search over one vault root (#138): a lazily built, incrementally refreshed in-memory index
 * (MiniSearch, BM25) whose terms are case- and diacritic-folded Snowball stems in the note's language.
 */

export const MAX_HITS = 200;
/** Matching lines shown per file (ripgrep's old `--max-count`). */
const MAX_LINES_PER_FILE = 20;
/** A longer line is cut to this many characters around its first match. */
const MAX_LINE = 300;
/** Bigger files (and binary ones) are found by name and path only. */
const MAX_INDEXED_BYTES = 1024 * 1024;
/** Longer "words" are ids, hashes or encoded data, not words anyone searches. */
const MAX_TOKEN = 40;
/** Text shorter than this is too little for language detection: its words get the stems of every language. */
const MIN_DETECT = 40;
/** How much of a note the detector reads. */
const DETECT_SAMPLE = 600;
/** Words of one query looked up at most (a longer query ignores the rest). */
export const MAX_QUERY_WORDS = 20;
/** Field weights: a word in the file name counts most, then headings, then frontmatter. */
const BOOST = { title: 3, headings: 2, meta: 1.5, path: 1, body: 1, titleWords: 3, words: 1 };
/**
 * Fields an exact or prefix lookup searches: the stems. `titleWords` and `words` hold the note's distinct words unstemmed
 * (folded) and are searched only by the typo lookup: a stem can be too short for it ("renovaton" is 4 edits from the
 * English stem "renov", 1 from "renovation").
 */
const STEM_FIELDS = ['title', 'headings', 'meta', 'path', 'body'];
const FIELDS = Object.keys(BOOST) as (keyof typeof BOOST)[];
/** Shorter words are never looked up with typo tolerance, so the unstemmed fields leave them out. */
const MIN_FUZZY = 4;

/** The languages with a stemmer; the detector chooses only among these. */
export type Lang = 'de' | 'en' | 'fr' | 'es' | 'it';
const LANGS: Lang[] = ['de', 'en', 'fr', 'es', 'it'];
const FRANC_CODES: Record<string, Lang> = { deu: 'de', eng: 'en', fra: 'fr', spa: 'es', ita: 'it' };
const STEM: Record<Lang, (w: string) => string> = {
  // German2 variant: "ue", "oe", "ae" are the umlauts typed without them ("Handtuecher" = "Handtücher").
  de: (w) => stemDe(w.replace(/(?<!q)ue/g, 'ü').replace(/oe/g, 'ö').replace(/ae/g, 'ä')),
  en: stemEn,
  fr: stemFr,
  es: stemEs,
  it: stemIt,
};

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** A line of base64 (an attachment in a mail): not text. */
const ENCODED_LINE = /^[A-Za-z0-9+/=]{60,}$/;

/** Lower case without diacritics: "Handtücher" → "handtucher", "Straße" → "strasse", "Œuvre" → "oeuvre". */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .replace(/ı/g, 'i');
}

/** The words of `text` with their offsets. */
function words(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(WORD)) out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * The note's language: a frontmatter `lang`/`language` code if it names a supported one, else franc's trigram
 * model (franc-min, deterministic, local) restricted to the stemmer languages; null for too little text.
 */
export function detectLanguage(text: string, frontmatter = ''): Lang | null {
  const declared = /^(?:lang|language):[ \t]*["']?([a-z]{2})\b/im.exec(frontmatter)?.[1]?.toLowerCase();
  if (declared && (LANGS as string[]).includes(declared)) return declared as Lang;
  const sample = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>`[\]()|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETECT_SAMPLE);
  if (sample.length < MIN_DETECT) return null;
  return FRANC_CODES[franc(sample, { only: Object.keys(FRANC_CODES) })] ?? null;
}

/** Stemming is the bulk of indexing: words repeat, so their terms are remembered (bounded). */
const termCache = new Map<string, string[]>();
const TERM_CACHE_MAX = 200_000;

/** Index terms of one word: its folded stem in `lang`; without a language, the stems of all of them. */
export function wordTerms(word: string, lang: Lang | null): string[] {
  const key = `${lang ?? ''}:${word}`;
  let terms = termCache.get(key);
  if (!terms) {
    const w = word.toLowerCase();
    terms = lang ? [fold(STEM[lang](w))] : [...new Set(LANGS.map((l) => fold(STEM[l](w))))];
    if (termCache.size >= TERM_CACHE_MAX) termCache.clear();
    termCache.set(key, terms);
  }
  return terms;
}

/** What a query word may match: the folded word itself and its folded stem in every language. */
function queryVariants(word: string): string[] {
  const w = word.toLowerCase();
  return [...new Set([fold(w), ...LANGS.map((l) => fold(STEM[l](w)))])];
}

/** The distinct folded words of `text` that a typo lookup may reach (not stemmed). */
function plainWords(text: string): string {
  const raw = new Set<string>();
  for (const m of text.matchAll(WORD)) if (m[0].length >= MIN_FUZZY && m[0].length <= MAX_TOKEN) raw.add(m[0]);
  return [...new Set([...raw].map(fold))].join(' ');
}

function indexText(text: string, lang: Lang | null): string {
  const out: string[] = [];
  for (const { word } of words(text)) if (word.length <= MAX_TOKEN) out.push(...wordTerms(word, lang));
  return out.join(' ');
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Files whose change can change what the listing leaves out: the next search re-lists the vault. */
const IGNORE_FILES = new Set(['.gitignore', '.ignore', '.rgignore']);

interface DocMeta {
  mtimeMs: number;
  size: number;
  lang: Lang | null;
  /** False: binary or too big, found by name and path only. */
  text: boolean;
}

interface Group {
  /** Folded query word (prefix and fuzzy matching start from it). */
  raw: string;
  variants: string[];
  prefix: boolean;
}

interface Term {
  /** The words of a "quoted phrase", folded; empty for a single word. */
  phrase: string[];
  groups: Group[];
}

/** Words of a query: whitespace-separated, or "quoted phrases" kept whole. */
export function queryTerms(q: string): string[] {
  const terms = [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  return terms.length > 0 ? terms : [q];
}

/**
 * The query as terms to look up. A repeated word counts once, and at most MAX_QUERY_WORDS words are looked up
 * (the rest are ignored): ranking is synchronous, one index lookup per word.
 */
export function parseQuery(q: string): Term[] {
  const raw = [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => ({ text: (m[1] ?? m[2] ?? '').trim(), quoted: m[1] !== undefined })).filter((t) => t.text);
  const out: Term[] = [];
  const seen = new Map<string, Group>();
  let budget = MAX_QUERY_WORDS;
  raw.forEach((t, i) => {
    const ws = words(t.text.normalize('NFC'))
      .map((w) => w.word)
      .filter((w) => w.length <= MAX_TOKEN);
    if (!ws.length || budget <= 0) return;
    const last = i === raw.length - 1 && !t.quoted;
    if (t.quoted && ws.length > 1) {
      const phrase = ws.slice(0, budget).map(fold);
      const key = `"${phrase.join(' ')}`;
      if (seen.has(key)) return;
      const groups = ws.slice(0, budget).map((w) => ({ raw: fold(w), variants: queryVariants(w), prefix: false }));
      seen.set(key, groups[0]!);
      budget -= groups.length;
      out.push({ phrase, groups });
      return;
    }
    // "only-name" is two words; the last one typed is a prefix ("handt" finds "Handtuch").
    ws.forEach((w, j) => {
      const g = { raw: fold(w), variants: queryVariants(w), prefix: last && j === ws.length - 1 };
      const prev = seen.get(g.raw);
      // The word as a whole and as a prefix: both must match, which the whole word alone says.
      if (prev) prev.prefix &&= g.prefix;
      else if (budget > 0) {
        seen.set(g.raw, g);
        budget--;
        out.push({ phrase: [], groups: [g] });
      }
    });
  });
  return out;
}

/** Does the folded word sequence `seq` contain `phrase` in a row? */
function hasRun(seq: string[], phrase: string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= seq.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (seq[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** The paths (relative to `root`) git ignores; none outside a git repository. */
function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['check-ignore', '-z', '--stdin'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const code = (err as { code?: number } | null)?.code;
      // Exit code 1 = nothing ignored; 128 = not a git repository (ripgrep then applies no .gitignore either).
      if (err && code !== 1 && code !== 128) reject(err);
      else resolve(new Set(out.split('\0').filter(Boolean)));
    });
    // Outside a repository git exits without reading its input.
    child.stdin?.on('error', () => {});
    child.stdin?.end(paths.join('\0'));
  });
}

/** ripgrep's file list (hidden and git-ignored files left out, as the old ripgrep search did). */
function listFiles(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('rg', ['--files', '--no-messages'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      // Exit code 1 = no files; 2 = some unreadable entry (still listed what it could).
      if (err && ![1, 2].includes((err as { code?: number }).code ?? -1)) reject(err);
      else resolve(out.split('\n').filter((p) => p && !p.includes('�')).map((p) => p.replace(/^\.\//, '')));
    });
  });
}

const tick = () => new Promise<void>((r) => setImmediate(r));

interface Ranked {
  path: string;
  score: number;
  /** Every query word matched in the file name. */
  byName: boolean;
  /** Index terms that matched (single words only: a phrase is matched as written). */
  terms: Set<string>;
}

export class SearchIndex {
  private ms = new MiniSearch<{ id: string }>({
    fields: FIELDS,
    // Fields are pre-analysed (the stems depend on the note's language): the index only splits them.
    extractField: (doc, field) => (doc as unknown as Record<string, string>)[field] ?? '',
    tokenize: (s) => (s ? s.split(' ') : []),
    processTerm: (t) => t,
    searchOptions: { boost: BOOST, fields: STEM_FIELDS, tokenize: (s) => [s], processTerm: (t) => t },
  });
  private docs = new Map<string, DocMeta>();
  /** Unknown changes: the next search lists the files and compares every size and mtime. Initially the index is empty. */
  private full = true;
  /** Paths reported changed: the next search re-reads just these. */
  private forced = new Set<string>();
  private running: Promise<void> | null = null;
  private built = false;

  constructor(
    private readonly root: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /**
   * A file changed (the watcher, a save): the next search re-reads it. Without a path anything may have changed
   * (a folder moved, a pull): the next search re-lists the vault and re-reads what differs.
   */
  markStale(path?: string) {
    if (path && !IGNORE_FILES.has(path.slice(path.lastIndexOf('/') + 1))) this.forced.add(path);
    else this.full = true;
  }

  get size() {
    return this.docs.size;
  }

  /** Language of an indexed file (tests, logs). */
  languageOf(path: string): Lang | null | undefined {
    return this.docs.get(path)?.lang;
  }

  /** Builds or catches up now (in the background when a vault opens), so the first search doesn't wait. */
  async warm(): Promise<void> {
    await this.ensureFresh();
  }

  private async ensureFresh() {
    for (let i = 0; (this.full || this.forced.size) && i < 3; i++) {
      this.running ??= this.pass().finally(() => (this.running = null));
      await this.running;
    }
  }

  private async pass() {
    const t0 = Date.now();
    const full = this.full;
    const forced = this.forced;
    this.full = false;
    this.forced = new Set();
    let indexed = 0;
    try {
      if (!full) {
        // Hidden and git-ignored paths are never searched (ripgrep's listing leaves them out too).
        const visible = [...forced].filter((p) => !p.split('/').some((seg) => seg.startsWith('.')));
        const ignored = visible.length ? await gitIgnored(this.root, visible) : new Set<string>();
        for (const p of visible)
          if (ignored.has(p)) this.drop(p);
          else if (await this.update(p, true)) indexed++;
      } else {
        const files = await listFiles(this.root);
        const listed = new Set(files);
        for (const p of [...this.docs.keys()]) if (!listed.has(p)) this.drop(p);
        for (let i = 0; i < files.length; i += 64) {
          await Promise.all(files.slice(i, i + 64).map(async (p) => (await this.update(p, forced.has(p))) && indexed++));
          await tick();
        }
      }
    } catch (e) {
      this.full ||= full;
      for (const p of forced) this.forced.add(p);
      throw e;
    }
    if (!this.built) {
      this.built = true;
      const langs: Record<string, number> = {};
      for (const d of this.docs.values()) if (d.text) langs[d.lang ?? 'none'] = (langs[d.lang ?? 'none'] ?? 0) + 1;
      this.log(`search index: ${this.docs.size} files in ${Date.now() - t0} ms, languages ${JSON.stringify(langs)}`);
    } else if (indexed) this.log(`search index: ${indexed} files updated in ${Date.now() - t0} ms`);
  }

  private drop(path: string) {
    this.docs.delete(path);
    if (this.ms.has(path)) this.ms.discard(path);
  }

  /** The file's absolute path; null if it is gone, not a regular file, or reached through a symlink (never followed). */
  private async regularFile(path: string): Promise<{ abs: string; st: Stats } | null> {
    const abs = await resolveInVault(this.root, path).catch(() => null);
    const st = abs ? await lstat(abs).catch(() => null) : null;
    return abs && st?.isFile() ? { abs, st } : null;
  }

  /** (Re-)indexes one file if it is new, changed or `force`d; true if it did. */
  private async update(path: string, force: boolean): Promise<boolean> {
    const f = await this.regularFile(path);
    if (!f) {
      this.drop(path);
      return false;
    }
    const { abs, st } = f;
    const old = this.docs.get(path);
    if (old && !force && old.mtimeMs === st.mtimeMs && old.size === st.size) return false;
    let content = '';
    let text = false;
    if (st.size <= MAX_INDEXED_BYTES) {
      const buf = await readFile(abs).catch(() => null);
      if (!buf) {
        this.drop(path);
        return false;
      }
      text = !buf.subarray(0, 8000).includes(0);
      if (text) content = buf.toString('utf8').normalize('NFC');
    }
    const fm = FRONTMATTER.exec(content);
    const meta = fm?.[1] ?? '';
    const body = (fm ? content.slice(fm[0].length) : content)
      .split('\n')
      .filter((l) => !ENCODED_LINE.test(l.trim()))
      .join('\n');
    const lang = text ? detectLanguage(body, meta) : null;
    const headings = body
      .split('\n')
      .filter((l) => /^#{1,6}\s/.test(l))
      .join('\n');
    const slash = path.lastIndexOf('/');
    const doc = {
      id: path,
      // The full file name: `report.pdf`, `pdf` and `Meeting.md` find it, as the old ripgrep path search did.
      title: indexText(path.slice(slash + 1).normalize('NFC'), lang),
      path: indexText(slash < 0 ? '' : path.slice(0, slash).normalize('NFC'), lang),
      headings: indexText(headings, lang),
      meta: indexText(meta, lang),
      body: indexText(body, lang),
      titleWords: plainWords(path.slice(slash + 1).normalize('NFC')),
      words: plainWords(`${slash < 0 ? '' : path.slice(0, slash).normalize('NFC')}\n${meta}\n${body}`),
    };
    this.docs.set(path, { mtimeMs: st.mtimeMs, size: st.size, lang, text });
    if (this.ms.has(path)) this.ms.replace(doc);
    else this.ms.add(doc);
    return true;
  }

  /** Files matching one query word: score and matched terms per file. */
  private matchGroup(g: Group, fuzzy: boolean): Map<string, { score: number; terms: Set<string>; byName: boolean }> {
    const out = new Map<string, { score: number; terms: Set<string>; byName: boolean }>();
    // A word matches if any variant does; its score is the best variant's (not the sum).
    for (const v of g.variants) {
      const isRaw = v === g.raw;
      const results: SearchResult[] = this.ms.search(v, {
        prefix: !fuzzy && g.prefix && isRaw && v.length >= 2,
        fuzzy: fuzzy && isRaw && v.length >= MIN_FUZZY ? 0.25 : false,
        maxFuzzy: 2,
        ...(fuzzy && isRaw ? { fields: FIELDS } : {}),
      });
      for (const r of results) {
        const byName = Object.values(r.match).some((fields) => fields.includes('title') || fields.includes('titleWords'));
        const cur = out.get(r.id as string);
        if (!cur) out.set(r.id as string, { score: r.score, terms: new Set(r.terms), byName });
        else {
          cur.score = Math.max(cur.score, r.score);
          for (const t of r.terms) cur.terms.add(t);
          cur.byName ||= byName;
        }
      }
    }
    return out;
  }

  private async rank(terms: Term[]): Promise<Ranked[]> {
    let acc: Map<string, Ranked> | null = null;
    for (const term of terms) {
      for (const g of term.groups) {
        let m = this.matchGroup(g, false);
        // A typo: only a word that matches nothing at all is looked up approximately.
        if (!m.size && !term.phrase.length) m = this.matchGroup(g, true);
        const next = new Map<string, Ranked>();
        for (const [path, x] of m) {
          const prev: Ranked | undefined = acc ? acc.get(path) : { path, score: 0, byName: true, terms: new Set() };
          if (!prev) continue;
          if (!term.phrase.length) for (const t of x.terms) prev.terms.add(t);
          next.set(path, { ...prev, score: prev.score + x.score, byName: prev.byName && (term.phrase.length > 0 || x.byName) });
        }
        acc = next;
        if (!acc.size) return [];
      }
    }
    let ranked = [...(acc?.values() ?? [])];
    const phrases = terms.filter((t) => t.phrase.length);
    if (phrases.length) {
      const keep = await Promise.all(
        ranked.map(async (r) => {
          const text = await this.content(r.path);
          if (text === null) return false;
          // Like the old ripgrep search: within one line (or the path), not across a line break.
          const seqs = [r.path.normalize('NFC'), ...text.split('\n')].map((l) => words(l).map((w) => fold(w.word)));
          return phrases.every((p) => seqs.some((seq) => hasRun(seq, p.phrase)));
        }),
      );
      ranked = ranked.filter((_, i) => keep[i]);
    }
    // Notes named after the query first (#99), then by BM25 score, then by path (stable results, #7).
    return ranked.sort((a, b) => Number(b.byName) - Number(a.byName) || b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private async content(path: string): Promise<string | null> {
    const f = await this.regularFile(path);
    if (!f) return null;
    if (!this.docs.get(path)?.text) return '';
    const text = await readFile(f.abs, 'utf8').catch(() => null);
    return text === null ? null : text.normalize('NFC');
  }

  /** The matching lines of one file, with the matched words' ranges. */
  private lineHits(path: string, text: string, r: Ranked, phrases: string[][]): SearchHit[] {
    const lang = this.docs.get(path)?.lang ?? null;
    const out: SearchHit[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < MAX_LINES_PER_FILE; i++) {
      const line = lines[i]!.replace(/\r$/, '').trimEnd();
      if (ENCODED_LINE.test(line.trim())) continue;
      const ws = words(line);
      const ranges: [number, number][] = [];
      for (const w of ws) if (w.word.length <= MAX_TOKEN && (r.terms.has(fold(w.word)) || wordTerms(w.word, lang).some((t) => r.terms.has(t)))) ranges.push([w.start, w.end]);
      const folded = ws.map((w) => fold(w.word));
      for (const p of phrases)
        for (let k = 0; k + p.length <= ws.length; k++) if (p.every((x, j) => folded[k + j] === x)) ranges.push([ws[k]!.start, ws[k + p.length - 1]!.end]);
      if (!ranges.length) continue;
      ranges.sort((a, b) => a[0] - b[0]);
      out.push({ path, line: i + 1, ...cut(line, merge(ranges)) });
    }
    return out;
  }

  async search(q: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    await this.ensureFresh();
    const terms = parseQuery(q);
    if (!terms.length) return { hits: [], truncated: false };
    const phrases = terms.filter((t) => t.phrase.length).map((t) => t.phrase);
    const hits: SearchHit[] = [];
    for (const r of await this.rank(terms)) {
      const text = await this.content(r.path);
      // Deleted or renamed since the last refresh.
      if (text === null) {
        this.markStale(r.path);
        continue;
      }
      const lines = this.lineHits(r.path, text, r, phrases);
      hits.push(...(lines.length ? lines : [{ path: r.path, line: 0, text: r.path }]));
      if (hits.length > MAX_HITS) break;
    }
    return { hits: hits.slice(0, MAX_HITS), truncated: hits.length > MAX_HITS };
  }
}

/** Overlapping or touching ranges joined. */
function merge(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of ranges) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** A line longer than MAX_LINE, cut around its first match (`…` marks a cut), ranges shifted to match. */
function cut(line: string, ranges: [number, number][]): { text: string; ranges: [number, number][] } {
  if (line.length <= MAX_LINE) return { text: line, ranges };
  const start = Math.max(0, Math.min(ranges[0]![0] - 100, line.length - MAX_LINE));
  const end = start + MAX_LINE;
  const pre = start > 0 ? '…' : '';
  const text = pre + line.slice(start, end) + (end < line.length ? '…' : '');
  const shift = pre.length - start;
  return { text, ranges: ranges.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + shift, b + shift]) };
}
