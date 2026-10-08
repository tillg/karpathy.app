import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { mdEmbed, wikiEmbed, type Embed, type Resolved } from './media';
import { parseWikilink, wikilinkLabel } from './wikilink';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `---\n…\n---` at the very start of a note. */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  return m ? { frontmatter: m[1]!, body: md.slice(m[0].length) } : { frontmatter: null, body: md };
}

/** Last frontmatter line (0 when the note has none): the closing `---` of a `---` block at the very start. */
export function frontmatterEndLine(text: string): number {
  const fm = splitFrontmatter(text.slice(0, 20_000)).frontmatter;
  return fm === null ? 0 : fm.split('\n').length + 2;
}

/** The `%%comment%%` ranges Read mode hides: from after an opening `%%` to after its closing one (or the end). */
export function commentRanges(text: string): [number, number][] {
  const marks = [...text.matchAll(/%%/g)].map((m) => m.index + 2);
  const out: [number, number][] = [];
  for (let i = 0; i < marks.length; i += 2) out.push([marks[i]!, marks[i + 1] ?? Infinity]);
  return out;
}

/** True when `pos` lies inside one of `ranges` (from `commentRanges`). */
export const inComment = (ranges: [number, number][], pos: number) => ranges.some(([from, to]) => pos >= from && pos < to);

/** A display value: a scalar (quotes removed), a list, or raw text for shapes this reader doesn't know. */
export type FieldValue = string | string[];

/** Strips matching YAML quotes from a scalar (`''` is an escaped `'` in single quotes). */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** `[a, "b, c"]` → items; null when it isn't a well-formed flat inline list. */
function inlineList(v: string): string[] | null {
  if (!v.startsWith('[') || !v.endsWith(']')) return null;
  const body = v.slice(1, -1);
  const items: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') return null;
    if (ch === ',') { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (quote) return null;
  if (cur.trim() || items.length) items.push(cur.trim());
  return items.map(unquote);
}

/**
 * Top-level frontmatter fields for Read mode (#58; display only, not a YAML parser): flat
 * `key: value`, inline `[a, b]` and block `- a` lists; anything else is shown as raw text.
 */
export function frontmatterFields(fm: string): [string, FieldValue][] {
  const out: [string, FieldValue][] = [];
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w][\w -]*):(?:\s+(.*))?$/.exec(lines[i]!);
    if (!m) continue;
    const head = (m[2] ?? '').trim();
    // Following lines that belong to this key: indented, or `- ` items flush with it.
    const rest: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || /^- /.test(lines[i + 1]!) || !lines[i + 1]!.trim())) rest.push(lines[++i]!);
    const more = rest.map((l) => l.trim()).filter(Boolean);
    let value: FieldValue;
    if (!head && more.length && more.every((l) => /^- /.test(l) || l === '-')) value = more.map((l) => unquote(l.slice(1).trim()));
    else if (!head) value = more.join('\n');
    else if (/^[|>][+-]?$/.test(head)) value = more.join('\n');
    else if (!more.length) value = inlineList(head) ?? unquote(head);
    else value = [head, ...more].join(' ');
    out.push([m[1]!, value]);
  }
  return out;
}

// Obsidian syntax that must not fire inside code: fenced blocks and code spans are matched first.
const CODE = '```[\\s\\S]*?```|~~~[\\s\\S]*?~~~|`[^`\\n]*`';
const COMMENT_RE = new RegExp(`(${CODE})|%%[\\s\\S]*?%%`, 'g');
const FOOTNOTE_DEF_RE = new RegExp(`(${CODE})|^\\[\\^([^\\]\\s]+)\\]:[ \\t]*(.*(?:\\n(?:[ \\t]{2,}|\\t).*)*)\\n?`, 'gm');

/**
 * What an embed becomes in the HTML; the app mounts the player or file card into the span (lib/embed).
 * `ek` marks the placeholders as ours: raw HTML in a note must not forge one (see `renderMarkdown`).
 */
function embedHtml(r: Exclude<Resolved, { state: 'note' }>, ek: string): string {
  const mark = ` data-ek="${esc(ek)}"`;
  if (r.state === 'media') {
    return `<span class="embed" data-path="${esc(r.path)}" data-kind="${r.kind}"${r.width ? ` data-width="${r.width}"` : ''}${r.alt ? ` data-alt="${esc(r.alt)}"` : ''}${mark}></span>`;
  }
  if (r.state === 'file') return `<span class="embed" data-path="${esc(r.path)}" data-kind="file"${mark}></span>`;
  // Remote images are blocked (tracking pixels): a link instead. Inline `data:image/*` carries its bytes and stays an image.
  if (r.state === 'remote') {
    return /^data:image\//i.test(r.href) ? `<img src="${esc(r.href)}" alt="${esc(r.alt ?? '')}">` : `<a href="${esc(r.href)}">${esc(r.alt || r.href)}</a>`;
  }
  return `<span class="embed miss" data-target="${esc(r.target)}"${mark}></span>`;
}

/** Text removed from a string by one pass: where (in the shortened text), how many characters and lines. */
type Cut = { at: number; chars: number; lines: number };

/** `src.replace(re, fn)` where a null from `fn` removes the match, and the removals are recorded. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- replace callbacks take the match groups
function strip(src: string, re: RegExp, fn: (...m: any[]) => string | null): { text: string; cuts: Cut[] } {
  const cuts: Cut[] = [];
  let gone = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = src.replace(re, (...m: any[]) => {
    const r = fn(...m);
    if (r !== null) return r;
    const raw = m[0] as string;
    cuts.push({ at: m[m.length - 2] - gone, chars: raw.length, lines: raw.split('\n').length - 1 });
    gone += raw.length;
    return '';
  });
  return { text, cuts };
}

const newlines = (s: string) => s.split('\n').length - 1;

/**
 * Markdown → HTML (not sanitized). Wikilinks become `<a class="wl" data-target>`. With `startLine`
 * (the file line of `md`'s first line), each top-level block's first tag gets `data-line` = its source line.
 */
export function toHtml(md: string, exists: (target: string) => boolean, opts: { startLine?: number; resolveEmbed?: (e: Embed) => Resolved; ek?: string } = {}): string {
  const { startLine, resolveEmbed, ek = '' } = opts;
  // `%%comment%%` is never shown (#112); `[^id]: text` definitions are collected for the footnotes section (#115).
  const defs = new Map<string, string>();
  const comments = strip(md, COMMENT_RE, (_m, code?: string) => code ?? null);
  const notes = strip(comments.text, FOOTNOTE_DEF_RE, (m: string, code: string | undefined, id: string, text: string) => {
    if (code !== undefined) return m;
    defs.set(id, text.replace(/\s*\n\s*/g, ' ').trim());
    return null;
  });
  md = notes.text;
  /** Line (in the original) of an offset in the shortened `md`: its own newlines plus the removed ones before it. */
  const lineAt = (pos: number) => {
    let line = newlines(md.slice(0, pos)) + (startLine ?? 1);
    let p = pos;
    for (const cuts of [notes.cuts, comments.cuts]) {
      const before = cuts.filter((c) => c.at <= p);
      line += before.reduce((n, c) => n + c.lines, 0);
      p += before.reduce((n, c) => n + c.chars, 0);
    }
    return line;
  };
  const order: string[] = [];
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [{
      name: 'wikilink',
      level: 'inline',
      start: (src) => src.indexOf('[['),
      tokenizer(src) {
        const m = /^\[\[([^[\]\n]+?)\]\]/.exec(src);
        return m ? { type: 'wikilink', raw: m[0], inner: m[1] } : undefined;
      },
      renderer(tok) {
        const inner = tok.inner as string;
        const l = parseWikilink(inner);
        const cls = !l.target || exists(l.target) ? 'wl' : 'wl miss';
        return `<a href="#" class="${cls}" data-target="${esc(inner)}">${esc(wikilinkLabel(l))}</a>`;
      },
    }],
  });
  marked.use({
    extensions: [{
      // `![[note]]` → the wikilink as a link marked as embed, no transclusion (#114).
      name: 'wikiembed',
      level: 'inline',
      start: (src) => src.indexOf('![['),
      tokenizer(src) {
        const m = /^!\[\[([^[\]\n]+?)\]\]/.exec(src);
        return m ? { type: 'wikiembed', raw: m[0], inner: m[1] } : undefined;
      },
      renderer(tok) {
        const inner = tok.inner as string;
        const r = resolveEmbed?.(wikiEmbed(inner));
        if (r && r.state !== 'note') return embedHtml(r, ek);
        const link = marked.defaults.extensions!.renderers.wikilink!.call(this, { type: 'wikilink', raw: tok.raw, inner: r?.state === 'note' ? r.inner : inner });
        return String(link).replace('class="wl', 'class="wl embed');
      },
    }, {
      name: 'highlight',
      level: 'inline',
      start: (src) => src.indexOf('=='),
      tokenizer(src) {
        const m = /^==(?!=)([^=\n](?:[^\n]*?[^=\n])?)==(?!=)/.exec(src);
        return m ? { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]!) } : undefined;
      },
      renderer(tok) {
        return `<mark>${this.parser.parseInline(tok.tokens!)}</mark>`;
      },
    }, {
      name: 'footnoteRef',
      level: 'inline',
      start: (src) => src.indexOf('[^'),
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]/.exec(src);
        return m && defs.has(m[1]!) ? { type: 'footnoteRef', raw: m[0], id: m[1] } : undefined;
      },
      renderer(tok) {
        const id = tok.id as string;
        if (!order.includes(id)) order.push(id);
        const n = order.indexOf(id) + 1;
        return `<sup class="fn"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
      },
    }],
    renderer: {
      // `![alt](path)`: a placeholder the app fills with the file (never an <img src>: the bytes need the bearer token).
      image({ href, text }) {
        if (!resolveEmbed) return false;
        const r = resolveEmbed(mdEmbed(href, text));
        if (r.state === 'note') return `<a href="#" class="wl embed" data-target="${esc(r.inner)}">${esc(wikilinkLabel(parseWikilink(r.inner)))}</a>`;
        return embedHtml(r, ek);
      },
      // GFM task items: DOMPurify drops <input>, so show a non-interactive marker (#102).
      checkbox({ checked }) {
        return `<span class="task" data-done="${checked}" aria-label="${checked ? 'done' : 'not done'}" role="img">${checked ? '☑' : '☐'}</span> `;
      },
      // Obsidian callouts `> [!type] Title` (#111); foldable `+`/`-` markers are ignored.
      blockquote({ tokens }) {
        const html = this.parser.parse(tokens);
        const m = /^<p>\[!([\w-]+)\][+-]?[ \t]*([^\n]*?)(\n|<\/p>)/.exec(html);
        if (!m) return false;
        const type = m[1]!.toLowerCase();
        const title = m[2] || type.charAt(0).toUpperCase() + type.slice(1);
        const body = (m[3] === '\n' ? '<p>' : '') + html.slice(m[0].length);
        return `<div class="callout" data-callout="${esc(type)}"><div class="callout-title">${title}</div><div class="callout-body">${body}</div></div>\n`;
      },
    },
  });
  let html: string;
  if (startLine === undefined) html = marked.parse(md, { async: false });
  else {
    // Each top-level block is rendered on its own; the concatenation equals `marked.parse`.
    html = '';
    let pos = 0;
    for (const tok of marked.lexer(md)) {
      const out = marked.parser([tok]);
      html += tok.type === 'space' ? out : out.replace(/^<([a-z][a-z0-9]*)/i, `<$1 data-line="${lineAt(pos + tok.raw.length - tok.raw.trimStart().length)}"`);
      pos += tok.raw.length;
    }
  }
  if (!order.length) return html;
  // A definition may reference further footnotes: they join `order` while it is rendered.
  const items: string[] = [];
  for (let i = 0; i < order.length; i++) {
    items.push(`<li id="fn-${i + 1}">${marked.parseInline(defs.get(order[i]!)!, { async: false })} <a href="#fnref-${i + 1}" class="fn-back">↩</a></li>`);
  }
  return `${html}<section class="footnotes"><ol>${items.join('')}</ol></section>\n`;
}

// Notes come from git (other devices, collaborators, AI-ingested sources): no forms (phishing
// on our origin) and no inline styles (full-screen overlays / clickjacking) (#31).
const PURIFY = {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'style', 'link', 'meta', 'base', 'dialog'],
  FORBID_ATTR: ['style', 'formaction', 'form', 'autofocus'],
};

// Code blocks scroll sideways: focusable, so the keyboard can scroll them (#45).
const focusablePre = (html: string) => html.replace(/<pre(?=[\s>])/g, '<pre tabindex="0"');

/**
 * What rendering needs from the app: which `[[targets]]` exist, where links point (`href` for a wikilink
 * target, `relative` for a Markdown link to a vault file) and what an embed refers to.
 */
export interface RenderCtx {
  exists: (target: string) => boolean;
  href?: (target: string) => string | null;
  relative?: (href: string) => { path: string; href: string } | null;
  resolveEmbed?: (e: Embed) => Resolved;
}

const EXTERNAL = /^(https?:|mailto:|\/\/)/i;

/**
 * Link fix-ups after sanitizing (DOMPurify drops `target`): external links open in a new tab
 * (#110); wikilinks get their note's route as href so open-in-new-tab/copy-link work (#109);
 * relative links to vault notes get that route plus `data-note` for in-app clicks (#116).
 */
function linkHook(ctx: RenderCtx) {
  return (node: Element) => {
    if (node.tagName !== 'A') return;
    node.removeAttribute('data-note'); // only ours: a note's raw HTML must not forge it
    const href = node.getAttribute('href') ?? '';
    if (node.classList.contains('wl')) {
      const l = parseWikilink(node.getAttribute('data-target') ?? '');
      const h = l.target ? ctx.href?.(l.target) : null;
      if (h) node.setAttribute('href', h);
    } else if (EXTERNAL.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else {
      const r = ctx.relative?.(href);
      if (r) { node.setAttribute('href', r.href); node.setAttribute('data-note', r.path); }
    }
  };
}

const EMBED_ATTRS = ['data-path', 'data-kind', 'data-width', 'data-alt', 'data-target'];

/** Only the renderer's own embed placeholders (marked with this render's `ek`) keep their embed attributes. */
function embedHook(ek: string) {
  return (node: Element) => {
    if (node.tagName === 'A') return; // `a.wl.embed` is the note-embed link, never a placeholder
    const ours = node.getAttribute('data-ek') === ek;
    node.removeAttribute('data-ek');
    if (ours) return;
    for (const a of EMBED_ATTRS) node.removeAttribute(a);
    node.classList.remove('embed');
    if (!node.getAttribute('class')) node.removeAttribute('class');
  };
}

export const renderMarkdown = (md: string, ctx: RenderCtx, startLine?: number) => {
  const ek = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const hooks = [linkHook(ctx), embedHook(ek)];
  for (const h of hooks) DOMPurify.addHook('afterSanitizeAttributes', h);
  try {
    return focusablePre(DOMPurify.sanitize(toHtml(md, ctx.exists, { startLine, resolveEmbed: ctx.resolveEmbed, ek }), PURIFY));
  } finally {
    for (const h of hooks) DOMPurify.removeHook('afterSanitizeAttributes', h);
  }
};
