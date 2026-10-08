// CodeMirror 6 live-preview extensions. They only add decorations over the raw text; the
// document itself is never rewritten (lossless round-trip, mvp §2.2).
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { mountEmbed, type EmbedCtx } from './embed';
import { commentRanges, frontmatterEndLine, inComment } from './outline';
import { EMBED_RE, knownNatural, mdEmbed, wikiEmbed, type Embed, type Resolved } from './media';
import { WIKILINK_RE } from './wikilink';

const style = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700' },
  { tag: tags.heading2, fontWeight: '650' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: [tags.link, tags.url], class: 'cm-md-link' },
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
  { tag: tags.quote, class: 'cm-md-quote' },
]);

const lineDeco = (cls: string) => Decoration.line({ class: cls });
const HEADING: Record<string, string> = { ATXHeading1: 'cm-h1', ATXHeading2: 'cm-h2', ATXHeading3: 'cm-h3', ATXHeading4: 'cm-h4', ATXHeading5: 'cm-h4', ATXHeading6: 'cm-h4' };

/** Frontmatter block + heading/quote line classes. */
const lines = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view: EditorView): DecorationSet {
    const doc = view.state.doc;
    const b = new RangeSetBuilder<Decoration>();
    // Frontmatter: only when the note starts with `---` and a closing `---` exists.
    const fmEnd = frontmatterEnd(view.state);
    const deco = new Map<number, string>();
    for (let n = 1; n <= fmEnd; n++) deco.set(doc.line(n).from, n === 1 ? 'cm-fm cm-fm-top' : n === fmEnd ? 'cm-fm cm-fm-bot' : 'cm-fm');
    const fmTo = fmEnd ? doc.line(fmEnd).to : -1;
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from, to,
        enter: (n) => {
          if (n.from <= fmTo) return;
          const cls = HEADING[n.name] ?? (n.name === 'Blockquote' ? 'cm-bq' : null);
          if (!cls) return;
          for (let pos = n.from; pos <= n.to;) {
            const line = doc.lineAt(pos);
            if (!deco.has(line.from)) deco.set(line.from, cls);
            pos = line.to + 1;
          }
        },
      });
    }
    for (const from of [...deco.keys()].sort((a, c) => a - c)) b.add(from, from, lineDeco(deco.get(from)!));
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

/** Re-evaluates which link targets exist (the file list changed, #55). */
export const refreshLinks = StateEffect.define<null>();

/** `[[wikilink]]` marks; click navigates unless the cursor is already inside the link. */
function wikilinks(exists: (target: string) => boolean, open: (inner: string) => void): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshLinks)))) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        for (const m of text.matchAll(WIKILINK_RE)) {
          const start = from + m.index;
          const inner = m[1]!;
          const target = inner.split('|')[0]!.split('#')[0]!.trim();
          b.add(start, start + 2, Decoration.mark({ class: 'cm-md-mark' }));
          b.add(start + 2, start + 2 + inner.length, Decoration.mark({
            class: !target || exists(target) ? 'cm-wl' : 'cm-wl cm-wl-miss',
            attributes: { 'data-target': inner },
          }));
          b.add(start + 2 + inner.length, start + 4 + inner.length, Decoration.mark({ class: 'cm-md-mark' }));
        }
      }
      return b.finish();
    }
  }, { decorations: (v) => v.decorations });

  const click = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-wl');
      if (!el || e.button !== 0) return false;
      const pos = view.posAtDOM(el);
      const head = view.state.selection.main.head;
      const inner = el.dataset.target ?? '';
      if (view.hasFocus && head >= pos - 2 && head <= pos + inner.length + 2) return false;
      e.preventDefault();
      open(inner);
      return true;
    },
  });
  return [plugin, click];
}

/** What the embed blocks need from the app; read at the time they are built or mounted, so it follows the latest props. */
export interface EmbedHooks {
  resolve(e: Embed): Resolved;
  ctx(): EmbedCtx;
  /** Changes when cached media bytes were dropped: shown players mount again. */
  epoch(): number;
}

type Shown = Extract<Resolved, { state: 'media' | 'file' | 'missing' }>;

/** The embeds of a line shown below it as one block; the text itself is untouched. */
class EmbedWidget extends WidgetType {
  private readonly key: string;
  constructor(readonly items: Shown[], readonly hooks: EmbedHooks, epoch: number) {
    super();
    this.key = `${epoch}${JSON.stringify(items)}`;
  }
  eq(o: EmbedWidget) { return o.key === this.key; }
  /** Before it is measured: the height the block will have, when every player's size is known from an earlier look (keeps a restored scroll position in place). */
  get estimatedHeight() {
    const vault = this.hooks.ctx().vault;
    let h = 10;
    for (const r of this.items) {
      const n = r.state === 'media' && r.kind !== 'audio' ? knownNatural(vault, r.path) : null;
      if (r.state === 'media' && r.kind !== 'audio' && !n) return -1;
      h += 20 + (r.state === 'media' ? (r.kind === 'audio' ? 54 : Math.round(n!.h * Math.min(1, (r.width ?? n!.w) / n!.w))) : 56);
    }
    return h;
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-embed';
    const stops = this.items.map((r) => {
      const host = document.createElement('span');
      host.className = 'embed';
      wrap.append(host);
      return mountEmbed(host, r, this.hooks.ctx());
    });
    (wrap as HTMLElement & { stop?: () => void }).stop = () => stops.forEach((s) => s());
    return wrap;
  }
  destroy(dom: HTMLElement & { stop?: () => void }) { dom.stop?.(); }
  // Clicks inside belong to the embed (a tap on an image opens it): the editor doesn't move the cursor.
  ignoreEvent() { return true; }
}

/** Last frontmatter line (0 when the note has none). */
export const frontmatterEnd = (state: EditorState) => frontmatterEndLine(state.doc.sliceString(0, Math.min(state.doc.length, 20_000)));

/** The frontmatter text between the `---` lines, in the editor's coordinates; null when the note has none. */
export function frontmatterRange(state: EditorState): { from: number; to: number; text: string } | null {
  const end = frontmatterEnd(state);
  if (!end) return null;
  const from = state.doc.line(2).from;
  const to = Math.max(from, state.doc.line(end - 1).to);
  return { from, to, text: state.doc.sliceString(from, to) };
}

/**
 * Hides the frontmatter lines (the properties form shows them, #82): one block replace over the whole
 * block, from state (block decorations can't come from a view plugin), and atomic, so the cursor skips it.
 * The text stays in the document.
 */
const hiddenFrontmatter = (state: EditorState) => {
  const end = frontmatterEnd(state);
  return end ? Decoration.set(Decoration.replace({ block: true }).range(0, state.doc.line(end).to)) : Decoration.none;
};
export const hideFrontmatter = StateField.define<DecorationSet>({
  create: hiddenFrontmatter,
  update: (v, tr) => (tr.docChanged ? hiddenFrontmatter(tr.state) : v),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
});

/**
 * Block widgets must come from state, not a view plugin. An edit only rebuilds the lines it touched (the
 * rest is mapped through the change); a new file list or dropped media bytes rebuild everything. Known
 * gap: an edit that turns later lines into code (an opened fence) is picked up at the next full rebuild.
 */
function embeds(hooks: EmbedHooks): Extension {
  /** The widget decorations of lines `fromLine..toLine`, in document order. */
  const build = (state: EditorState, fromLine: number, toLine: number, full: boolean) => {
    const out: { pos: number; deco: Decoration }[] = [];
    const tree = full ? (ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)) : syntaxTree(state);
    const fmEnd = frontmatterEnd(state);
    const epoch = hooks.epoch();
    // Read mode hides `%%comments%%`, so no embed there.
    let comments: [number, number][] | null = null;
    for (let n = Math.max(fromLine, fmEnd + 1); n <= toLine; n++) {
      const line = state.doc.line(n);
      if (!line.text.includes('![')) continue;
      const items: Shown[] = [];
      for (const m of line.text.matchAll(EMBED_RE)) {
        let code = false;
        for (let node: { name: string; parent: unknown } | null = tree.resolveInner(line.from + m.index, 1); node; node = node.parent as typeof node) {
          if (/Code/.test(node.name)) code = true;
        }
        if (code || inComment(comments ??= commentRanges(state.doc.toString()), line.from + m.index)) continue;
        const r = hooks.resolve(m[1] !== undefined ? wikiEmbed(m[1]) : mdEmbed(m[3]!, m[2]));
        if (r.state === 'media' || r.state === 'file' || r.state === 'missing') items.push(r);
      }
      if (items.length) out.push({ pos: line.to, deco: Decoration.widget({ block: true, side: 1, widget: new EmbedWidget(items, hooks, epoch) }) });
    }
    return out;
  };
  const all = (state: EditorState) => Decoration.set(build(state, 1, state.doc.lines, true).map((x) => x.deco.range(x.pos)));
  return StateField.define<DecorationSet>({
    create: all,
    update(v, tr) {
      if (tr.effects.some((e) => e.is(refreshLinks))) return all(tr.state);
      if (!tr.docChanged) return v;
      let next = v.map(tr.changes);
      const doc = tr.state.doc;
      tr.changes.iterChangedRanges((_a, _b, from, to) => {
        const lo = doc.lineAt(from).from;
        const hi = doc.lineAt(Math.min(to, doc.length)).to;
        next = next.update({ filter: (f) => f < lo || f > hi });
        const add = build(tr.state, doc.lineAt(lo).number, doc.lineAt(hi).number, false);
        if (add.length) next = next.update({ add: add.map((x) => x.deco.range(x.pos)) });
      });
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export function liveMarkdown(exists: (target: string) => boolean, open: (inner: string) => void, embedHooks: EmbedHooks): Extension {
  return [markdown(), syntaxHighlighting(style), lines, wikilinks(exists, open), embeds(embedHooks), EditorView.lineWrapping];
}
