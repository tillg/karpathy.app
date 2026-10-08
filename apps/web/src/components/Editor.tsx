import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { ensureSyntaxTree } from '@codemirror/language';
import { frontmatterEnd, frontmatterRange, hideFrontmatter, liveMarkdown, refreshLinks } from '../lib/cm';
import { commentRanges } from '../lib/markdown';
import { collectHeadings, type OutlineItem } from '../lib/outline';
import { minimalChange } from '../lib/diff';
import { editorText, eolExtension } from '../lib/eol';
import type { Embed, Resolved } from '../lib/media';
import type { EmbedCtx } from '../lib/embed';

export interface EditorHandle {
  openSearch(): void;
  /** `focus: false` keeps the keyboard closed (mode switch); `align: 'start'` puts the line at the top, below the header. */
  gotoLine(line: number, opts?: { focus?: boolean; align?: 'center' | 'start' }): void;
  /** The document line at the top of the visible pane. */
  topLine(): number;
  /**
   * A place in the text (default: the cursor) that follows later edits, for embeds inserted after an
   * upload. `insert` puts `![[name]]` there on its own line; several inserts follow each other.
   */
  track(at?: number): TrackedPos;
  /** Replaces the text now, as a minimal change (selection and tracked positions follow); not reported as an edit. */
  setDoc(text: string): void;
  /** The selected text after the frontmatter (ranges joined by line breaks); null when nothing is selected there. */
  selectionText(): string | null;
  /**
   * A properties-form edit as one user change (autosave, drafts and undo treat it like typing), only when the
   * frontmatter is still `expect`: false and nothing written when the AI or a pull changed it meanwhile.
   */
  applyChange(change: { from: number; to: number; insert: string }, expect: FrontmatterText): boolean;
  /** The outline from the editor's syntax tree; null when the tree isn't complete in time (a very long note). */
  outline(): OutlineItem[] | null;
}

export interface TrackedPos {
  /** False when the editor is gone (another note or Read mode): the caller puts the embed in itself. */
  insert(embed: string): boolean;
  release(): void;
}

interface Props {
  doc: string;
  /** Changes on every (re)load, so a reload back to the same `doc` still replaces edited text. */
  docNonce?: number;
  readOnly: boolean;
  onChange(text: string): void;
  exists(target: string): boolean;
  onWikilink(inner: string): void;
  resolveEmbed(e: Embed): Resolved;
  embedCtx(): EmbedCtx;
  /** Changes when cached media bytes were dropped (see store `mediaEpoch`). */
  mediaEpoch: number;
  /** Files dropped from the device at document position `pos`; absent = file drops are ignored. */
  onDropFiles?(files: File[], pos: number): void;
  /** The selection changed. */
  onSelection?(): void;
  /** Hide the frontmatter lines (the properties form shows them). */
  hideFrontmatter?: boolean;
  /** The frontmatter text and its place, on create and whenever that text changes; null when there is none. */
  onFrontmatter?(fm: FrontmatterText | null): void;
  /** A search match, a hit or the cursor landed in the hidden frontmatter: show its lines. */
  onRevealFrontmatter?(): void;
}

/** The frontmatter between the `---` lines, in the editor's coordinates. */
export interface FrontmatterText { from: number; to: number; text: string }

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

/** Whether `pos` lies in the frontmatter block (its `---` lines included). */
const inFrontmatter = (v: EditorView, pos: number) => { const end = frontmatterEnd(v.state); return !!end && pos <= v.state.doc.line(end).to; };

/** Marks transactions that load content from the server (not user edits). */
const External = Annotation.define<boolean>();

/** CM6 in Write mode. Remount per note (key = path); `doc` updates replace the text in place. */
export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const ro = useRef(new Compartment());
  const hide = useRef(new Compartment());
  /** Whether the frontmatter lines are hidden now. */
  const hidden = useRef(false);
  /** Hides the frontmatter lines; a typed change that would reach them shows them instead. */
  const hideLines = useMemo(() => hideFrontmatter(() => latest.current.onRevealFrontmatter?.()), []);
  /** The frontmatter text last reported through `onFrontmatter`. */
  const reportedFm = useRef<string | null | undefined>(undefined);
  const reportFrontmatter = (state: EditorState) => {
    const fm = frontmatterRange(state);
    if ((fm?.text ?? null) === reportedFm.current) return;
    reportedFm.current = fm?.text ?? null;
    latest.current.onFrontmatter?.(fm);
  };
  /** Positions handed out by `track`, mapped through every change. */
  const tracked = useRef(new Set<{ pos: number }>());

  useEffect(() => {
    const doc = props.doc;
    const state = EditorState.create({
      doc,
      extensions: [
        eolExtension(doc),
        history(),
        search({ top: true }),
        keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
        liveMarkdown((t) => latest.current.exists(t), (i) => latest.current.onWikilink(i), {
          resolve: (e) => latest.current.resolveEmbed(e),
          ctx: () => latest.current.embedCtx(),
          epoch: () => latest.current.mediaEpoch,
        }),
        ro.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
        hide.current.of(props.hideFrontmatter ? hideLines : []),
        // A file from the device is uploaded and embedded where it was dropped; text drags stay CodeMirror's.
        EditorView.domEventHandlers({
          dragover: (e, v) => {
            if (!hasFiles(e)) return false;
            e.preventDefault();
            v.dom.classList.toggle('cm-drop-target', !!latest.current.onDropFiles);
            return true;
          },
          dragleave: (e, v) => {
            if (!v.dom.contains(e.relatedTarget as Node | null)) v.dom.classList.remove('cm-drop-target');
            return false;
          },
          drop: (e, v) => {
            if (!hasFiles(e)) return false;
            e.preventDefault();
            v.dom.classList.remove('cm-drop-target');
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.doc.length;
            latest.current.onDropFiles?.([...e.dataTransfer!.files], pos);
            return true;
          },
        }),
        EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'sentences', 'aria-label': 'Note editor' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) for (const t of tracked.current) t.pos = u.changes.mapPos(t.pos, 1);
          if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) latest.current.onChange(editorText(u.state));
          if (u.selectionSet) latest.current.onSelection?.();
          // A match of find-in-note inside the hidden lines (search selections are user `select` events).
          if (hidden.current && u.transactions.some((t) => t.isUserEvent('select.search')) && inFrontmatter(u.view, u.state.selection.main.head)) latest.current.onRevealFrontmatter?.();
          if (u.docChanged) reportFrontmatter(u.state);
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    reportedFm.current = undefined;
    reportFrontmatter(state);
    return () => {
      v.destroy();
      if (view.current === v) view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Replaces the text as a minimal change, so the selection and scroll position survive (issue #4). */
  const setDoc = (doc: string) => {
    const v = view.current;
    if (!v) return;
    const cur = editorText(v.state);
    const c = minimalChange(cur, doc);
    if (!c) return;
    // With a CRLF separator a line break is one position in CM but two chars in the string.
    const pos = (s: string, i: number) => (v.state.lineBreak === '\r\n' ? i - (s.slice(0, i).match(/\r\n/g)?.length ?? 0) : i);
    v.dispatch({ changes: { from: pos(cur, c.from), to: pos(cur, c.to), insert: c.insert }, annotations: External.of(true) });
  };
  // Reload in place.
  useEffect(() => setDoc(props.doc), [props.doc, props.docNonce]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) });
  }, [props.readOnly]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    hidden.current = !!props.hideFrontmatter;
    v.dispatch({ effects: hide.current.reconfigure(props.hideFrontmatter ? hideLines : []) });
    const head = v.state.selection.main.head;
    if (!inFrontmatter(v, head)) return;
    if (!props.hideFrontmatter) { v.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) }); return; }
    // A cursor in the lines being hidden moves below them (a hit there reveals them instead, in `gotoLine`).
    const end = frontmatterEnd(v.state);
    v.dispatch({ selection: { anchor: end < v.state.doc.lines ? v.state.doc.line(end + 1).from : v.state.doc.length } });
  }, [props.hideFrontmatter, hideLines]);

  // A new file list or dropped media bytes: missing-link marks and embeds follow (#55).
  useEffect(() => { view.current?.dispatch({ effects: refreshLinks.of(null) }); }, [props.exists, props.mediaEpoch]);

  useImperativeHandle(ref, () => ({
    openSearch: () => { if (view.current) openSearchPanel(view.current); },
    gotoLine: (line, opts) => {
      // `view.current` is read late: dev StrictMode remounts the view right after the effect that calls this.
      let settled = 0;
      const go = (): { done: boolean } => {
        const v = view.current;
        if (!v) return { done: true };
        const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
        const sc = v.dom.closest<HTMLElement>('.scroll');
        const pad = sc ? parseFloat(getComputedStyle(sc).paddingTop) : 0; // the header overlays this much
        if (opts?.align === 'start' && sc) {
          // Settled when the line is rendered right at the top, twice in a row (measuring can shift it).
          const top = v.coordsAtPos(l.from)?.top;
          if (top !== undefined && Math.abs(top - (sc.getBoundingClientRect().top + pad)) < 3) return { done: ++settled >= 2 };
          settled = 0;
          v.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: pad }) });
          return { done: false };
        }
        v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
        // Also before the lines are hidden (a hit opening the note): the reveal keeps them shown.
        if (inFrontmatter(v, l.from)) latest.current.onRevealFrontmatter?.();
        if (opts?.focus !== false) v.focus();
        return { done: true };
      };
      if (opts?.align !== 'start') { go(); return; }
      // Aligning to the top: after a layout pass (a scroll before it is clamped away), and again while CodeMirror measures its lines.
      let stop = false;
      const sc = view.current?.dom.closest<HTMLElement>('.scroll');
      const halt = () => { stop = true; };
      const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
      for (const e of events) sc?.addEventListener(e, halt, { passive: true });
      const retry = (left: number) => {
        if (stop || go().done || left === 0) for (const e of events) sc?.removeEventListener(e, halt);
        else setTimeout(() => retry(left - 1), 100);
      };
      requestAnimationFrame(() => requestAnimationFrame(() => retry(8)));
    },
    track: (at) => {
      const t = { pos: at ?? view.current?.state.selection.main.head ?? 0 };
      tracked.current.add(t);
      return {
        insert: (embed) => {
          const v = view.current;
          if (!v) return false;
          const pos = Math.min(t.pos, v.state.doc.length);
          const line = v.state.doc.lineAt(pos);
          const before = pos > line.from ? '\n' : '';
          const after = pos < line.to ? '\n' : '';
          v.dispatch({
            changes: { from: pos, insert: `${before}${embed}${after}` },
            annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.embed')],
          });
          // Right after the embed, so the next one goes on the following line.
          t.pos = pos + before.length + embed.length;
          return true;
        },
        release: () => void tracked.current.delete(t),
      };
    },
    setDoc,
    applyChange: (change, expect) => {
      const v = view.current;
      if (!v || v.state.doc.sliceString(expect.from, expect.to) !== expect.text) return false;
      v.dispatch({ changes: change, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.properties')] });
      return true;
    },
    outline: () => {
      const v = view.current;
      const tree = v && ensureSyntaxTree(v.state, v.state.doc.length, 50);
      if (!v || !tree) return null;
      const doc = v.state.doc;
      return collectHeadings(tree, (from, to) => doc.sliceString(from, to), (pos) => doc.lineAt(pos).number,
        { fmEnd: frontmatterEnd(v.state), comments: commentRanges(doc.toString()) });
    },
    selectionText: () => {
      const v = view.current;
      if (!v) return null;
      const doc = v.state.doc;
      const fm = frontmatterEnd(v.state);
      const body = fm ? Math.min(doc.length, doc.line(fm).to + 1) : 0;
      const parts = v.state.selection.ranges.filter((r) => r.to > body && !r.empty).map((r) => doc.sliceString(Math.max(r.from, body), r.to));
      return parts.length ? parts.join('\n') : null;
    },
    topLine: () => {
      const v = view.current;
      const sc = v?.dom.closest<HTMLElement>('.scroll');
      if (!v || !sc) return 1;
      const top = sc.getBoundingClientRect().top + parseFloat(getComputedStyle(sc).paddingTop);
      // The rendered lines have exact positions (CodeMirror's height map is only an estimate away from them).
      const el = [...v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find((e) => e.getBoundingClientRect().bottom > top + 1);
      return el ? v.state.doc.lineAt(v.posAtDOM(el)).number : 1;
    },
  }), []);

  return <div className="editor" data-testid="editor" ref={host} />;
});
