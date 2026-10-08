// The wiki schema (#82): the rules a wiki page's properties should follow. Built in (the LLM-wiki schema), or
// the vault's own `.karpathy/schema.json`, which replaces it as a whole.
import { isListKind, type Frontmatter, type LinkStyle, type PropertyKind } from './frontmatter';

export interface FieldRule { kind: PropertyKind; values?: string[]; required?: boolean; linkStyle?: LinkStyle }
/** `appliesTo`: vault-root folder prefixes the rules hold for (case-insensitive). */
export interface Schema { appliesTo: string[]; fields: Record<string, FieldRule> }

/** A property that doesn't follow the schema; shown, never fixed. `key` '' = the frontmatter as a whole. */
export interface Violation { key: string; message: string; index?: number }

export const SCHEMA_PATH = '.karpathy/schema.json';

export const DEFAULT_SCHEMA: Schema = {
  appliesTo: ['Wiki/'],
  fields: {
    type: { kind: 'enum', values: ['entity', 'concept', 'topic', 'source', 'synthesis'], required: true },
    tags: { kind: 'list', required: true },
    updated: { kind: 'date', required: true },
    sources: { kind: 'links' },
    related: { kind: 'links' },
    confidence: { kind: 'enum', values: ['high', 'medium', 'low'] },
  },
};

const KINDS = new Set<string>(['text', 'enum', 'date', 'number', 'boolean', 'list', 'links', 'raw']);
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

/** A schema file's text checked by hand: known kinds, `values` (strings) only on `enum`. */
export function parseSchema(json: string): Schema | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) { return { error: `not JSON: ${(e as Error).message}` }; }
  const o = raw as { appliesTo?: unknown; fields?: unknown };
  if (!o || typeof o !== 'object' || !isStrings(o.appliesTo)) return { error: '`appliesTo` must be a list of folders' };
  if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) return { error: '`fields` must be an object' };
  for (const [key, r] of Object.entries(o.fields as Record<string, Partial<FieldRule>>)) {
    if (!r || typeof r !== 'object' || !KINDS.has(r.kind as string)) return { error: `${key}: unknown kind` };
    if (r.values !== undefined && (r.kind !== 'enum' || !isStrings(r.values))) return { error: `${key}: \`values\` must be strings, on an enum only` };
    if (r.kind === 'enum' && !r.values) return { error: `${key}: an enum needs \`values\`` };
    if (r.required !== undefined && typeof r.required !== 'boolean') return { error: `${key}: \`required\` must be true or false` };
    if (r.linkStyle !== undefined && r.linkStyle !== 'wikilink' && r.linkStyle !== 'bare') return { error: `${key}: \`linkStyle\` must be wikilink or bare` };
  }
  return raw as Schema;
}

/** Whether the schema's rules hold for the note at `path`. */
export const applies = (schema: Schema, path: string) =>
  schema.appliesTo.some((f) => {
    const dir = f.replace(/^\/+|\/+$/g, '').toLowerCase(); // '' or '/' = the whole vault
    return !dir || path.toLowerCase().startsWith(`${dir}/`);
  });

/** `[[a]]` without quotes in a list reads as a list inside the list (`[["a"]]`), not as a link. */
const unquotedWikilink = (item: unknown) => Array.isArray(item) && item.length === 1 && Array.isArray(item[0]) && item[0].length === 1 && typeof item[0][0] === 'string';

const isDate = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const either = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs[0] ?? '');

/** The schema violations of a note's properties; none outside the schema's folders. Never changes `fm`. */
export function validate(fm: Pick<Frontmatter, 'props' | 'error'>, schema: Schema, path: string): Violation[] {
  if (!applies(schema, path)) return [];
  if (fm.error) return [{ key: '', message: fm.error }];
  const out: Violation[] = [];
  for (const [key, rule] of Object.entries(schema.fields)) {
    const p = fm.props.find((x) => x.key === key);
    const v = p?.value ?? null;
    if (v === null || v === '') {
      if (rule.required) out.push({ key, message: 'required on wiki pages' });
      continue;
    }
    if (isListKind(rule.kind)) {
      if (!Array.isArray(v)) out.push({ key, message: 'should be a list' });
    } else if (rule.kind === 'number' && typeof v !== 'number') out.push({ key, message: 'should be a number' });
    else if (rule.kind === 'boolean' && typeof v !== 'boolean') out.push({ key, message: 'should be true or false' });
    else if (rule.kind !== 'raw' && typeof v === 'object') out.push({ key, message: 'should be a single value' });
    else if (rule.kind === 'enum' && rule.values && !rule.values.includes(String(v))) out.push({ key, message: `must be ${either(rule.values)}` });
    else if (rule.kind === 'date' && !isDate(v)) out.push({ key, message: 'not a date (YYYY-MM-DD)' });
  }
  for (const p of fm.props) {
    if (Array.isArray(p.value)) p.value.forEach((item, index) => { if (unquotedWikilink(item)) out.push({ key: p.key, index, message: 'wikilinks in lists need quotes' }); });
  }
  return out;
}
