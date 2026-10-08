import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { frontmatterFields, renderMarkdown, splitFrontmatter, type FieldValue, type RenderCtx } from '../lib/markdown';
import { isPdf, isUploadable } from '@karpathy/shared';
import { mountEmbed, mountEmbeds, type Mounted } from '../lib/embed';
import { mediaKind, resolveEmbed } from '../lib/media';
import { editFrontmatter, parseProps, type Edit } from '../lib/frontmatter';
import { minimalChange } from '../lib/diff';
import { countText, readingMinutes } from '../lib/noteinfo';
import { applies, validate } from '../lib/schema';
import { currentHeading, outlineOfText } from '../lib/outline';
import { scrollToLine, topBlockLine } from '../lib/place';
import { incomingView } from '../lib/incoming';
import { formatRoute } from '../lib/route';
import { parseWikilink, resolveRelativeLink, resolveWikilink, wikilinkLabel, WIKILINK_RE } from '../lib/wikilink';
import { useApp } from '../store';
import { AttachButton } from './AttachButton';
import { Editor, type EditorHandle, type FrontmatterText } from './Editor';
import { GitPill } from './GitPill';
import { Icon } from './Icon';
import { OutlinePanel } from './OutlinePanel';
import { PropertiesPanel } from './PropertiesPanel';
import { PullLink } from './PullLink';

/** A plain left click is handled in-app; modified clicks (new tab, window, download) go to the browser (#109). */
const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** What rendering needs in the open note: where links point, which files exist and what embeds show. `base`: see `Markdown`. */
function useRenderCtx(base?: string): Required<RenderCtx> {
  const { activeId, paths, note, exists } = useApp();
  const from = base ?? note?.path;
  return useMemo(() => {
    const route = (p: string) => formatRoute(activeId, p);
    return {
      exists,
      href: (target) => { const p = resolveWikilink(target, paths, from); return p ? route(p) : null; },
      relative: (href) => { const p = from !== undefined && resolveRelativeLink(href, from, paths); return p ? { path: p, href: route(p) } : null; },
      resolveEmbed: (e) => resolveEmbed(e, from || null, paths),
    };
  }, [activeId, paths, from, exists]);
}

/** Rendered Read mode; `[[wikilinks]]` and relative links to vault notes are clickable. `base`: file path relative links resolve from (default the open note; '' = vault root, for chat). */
export function Markdown({ text, className, base, startLine }: { text: string; className?: string; base?: string; startLine?: number }) {
  const { followLink, openNote, activeId, toast, mediaEpoch, paths } = useApp();
  const ctx = useRenderCtx(base);
  const html = useMemo(() => renderMarkdown(text, ctx, startLine), [text, ctx, startLine]);
  const host = useRef<HTMLDivElement>(null);
  // Players and file cards are mounted into the embed placeholders. When the text changes (a chat answer
  // streaming in) the embeds that are still there keep their players; dropped cached bytes start over.
  const live = useRef({ openNote, toast });
  live.current = { openNote, toast };
  const mounted = useRef<{ list: Mounted[]; epoch: number; vault: string | null }>({ list: [], epoch: 0, vault: null });
  useLayoutEffect(() => {
    if (!host.current || !activeId) return;
    const m = mounted.current;
    const same = m.epoch === mediaEpoch && m.vault === activeId;
    if (!same) for (const x of m.list) x.stop();
    m.list = mountEmbeds(host.current, { vault: activeId, toast: (t) => live.current.toast(t), onOpen: (p) => void live.current.openNote(p) }, same ? m.list : []);
    m.epoch = mediaEpoch;
    m.vault = activeId;
  }, [html, activeId, mediaEpoch]);
  useEffect(() => () => { for (const x of mounted.current.list) x.stop(); mounted.current.list = []; }, []);
  return (
    <div className={className} ref={host} dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // Footnote links jump inside this block, not through the hash router (#115).
        const fn = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#fn"]');
        const id = fn?.getAttribute('href')?.slice(1);
        if (fn && id && /^fn(ref)?-\d+$/.test(id)) {
          e.preventDefault();
          e.currentTarget.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'center' });
          return;
        }
        const a = (e.target as HTMLElement).closest<HTMLElement>('a.wl, a[data-note]');
        if (!a || !plainClick(e)) return;
        e.preventDefault();
        if (a.dataset.note) void openNote(a.dataset.note);
        else if (base === undefined) followLink(a.dataset.target ?? '');
        else {
          // Chat: resolved from `base`, the same as the href shown on hover (not from the open note's folder).
          const l = parseWikilink(a.dataset.target ?? '');
          const p = l.target ? resolveWikilink(l.target, paths, base) : null;
          if (p) void openNote(p, undefined, l.heading);
          else toast(`No page “${l.target}” yet`);
        }
      }} />
  );
}

/**
 * Text with its `[[wikilinks]]` as links, resolved like the body's (#58). `bare`: a value without
 * `[[ ]]` that names an existing note (slug or file name) links too (#108).
 */
export function Linked({ text, bare }: { text: string; bare?: boolean }) {
  const { exists, followLink } = useApp();
  const ctx = useRenderCtx();
  const out: React.ReactNode[] = [];
  let last = 0;
  const link = (key: number, inner: string) => {
    const l = parseWikilink(inner);
    out.push(
      <a key={key} href={(l.target && ctx.href(l.target)) || '#'} className={!l.target || exists(l.target) ? 'wl' : 'wl miss'} data-target={inner}
        onClick={(e) => { if (plainClick(e)) { e.preventDefault(); followLink(inner); } }}>{wikilinkLabel(l)}</a>,
    );
  };
  if (bare && !text.includes('[[') && text.trim() && exists(text.trim())) {
    link(0, text.trim());
    return <>{out}</>;
  }
  for (const m of text.matchAll(WIKILINK_RE)) {
    out.push(text.slice(last, m.index));
    link(m.index, m[1]!);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** Frontmatter keys whose list items are note references. */
const NOTE_REF_KEYS = new Set(['related', 'sources']);

function PropValue({ k, v }: { k: string; v: FieldValue }) {
  if (typeof v === 'string') return <span className="pv"><Linked text={v} /></span>;
  const bare = NOTE_REF_KEYS.has(k.toLowerCase());
  return <span className="pv chips">{v.map((item, i) => <span className="chip" key={i}><Linked text={item} bare={bare} /></span>)}</span>;
}

function ReadView({ text }: { text: string }) {
  const { frontmatter, body } = splitFrontmatter(text);
  return (
    <div className="read" data-testid="read-view">
      {frontmatter !== null && (
        <div className="props">
          {frontmatterFields(frontmatter).map(([k, v], i) => <div className="prop" key={`${k}${i}`}><span>{k}</span><PropValue k={k} v={v} /></div>)}
        </div>
      )}
      <Markdown text={body} className="rd" startLine={text.slice(0, text.length - body.length).split('\n').length} />
    </div>
  );
}

/** A media file or other binary file opened on its own: the player or file card, never an editor. */
function MediaView({ path }: { path: string }) {
  const { activeId, toast, mediaEpoch } = useApp();
  const host = useRef<HTMLSpanElement>(null);
  const kind = mediaKind(path);
  const pdf = isPdf(path);
  useLayoutEffect(() => {
    if (!host.current || !activeId) return;
    const ctx = { vault: activeId, toast };
    return mountEmbed(host.current, kind ? { state: 'media', path, kind } : { state: 'file', path }, ctx);
  }, [path, kind, activeId, toast, mediaEpoch]);
  const name = path.split('/').pop()!;
  return (
    <div className="doc media-view">
      <h2 className="note-title">{name}</h2>
      {!kind && !pdf && (
        <div className="placeholder" data-testid="binary-file">
          <Icon n="doc" size={48} />
          <p><b>{name}</b><br />Binary file — can’t be edited here.</p>
        </div>
      )}
      <span className="embed" ref={host} />
    </div>
  );
}

export function NotePane({ inert }: { inert?: boolean }) {
  const s = useApp();
  const { note, mode, setMode, readOnly, online, conflict, phone, wide } = s;
  const editor = useRef<EditorHandle>(null);
  const rctx = useRenderCtx();
  // The same note while an upload moves it into its own folder: the editor and the scroll position stay.
  const noteKey = note && (note.openedAs ?? note.path);
  const inc = incomingView(s.status, s.pulling);
  // Warns only; editing stays allowed (the pull saves the draft first, then its stash, re-apply and conflict flow protect the text).
  const noteIncoming = inc.show && !!note && s.status!.incomingPaths.includes(note.path);

  // A fresh open lands at the top; Back to a seen note (`restore`) returns to where it was left. The
  // restore is re-applied for a second while the layout settles (CodeMirror measuring, embeds loading).
  useLayoutEffect(() => {
    const byLine = mode === 'write' && !!note?.restore?.line; // the editor scrolls to the line itself, below
    if (s.scrollRef.current) s.scrollRef.current.scrollTop = byLine ? 0 : note?.restore?.top ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteKey, note?.restore, s.scrollRef]);
  /** Stops a running place restore (below); a mode switch does, so it can't fight the switch's own alignment. */
  const stopRestore = useRef(() => {});
  s.placeNow.current = () => ({ top: s.scrollRef.current?.scrollTop ?? 0, ...(mode === 'write' ? { line: editor.current?.topLine() } : {}) });
  useEffect(() => {
    const el = s.scrollRef.current;
    const top = note?.restore?.top;
    if (!el || top === undefined) return;
    // Write mode: by line, CodeMirror's pixel positions are estimates that shift as lines are measured.
    if (mode === 'write' && note?.restore?.line) { editor.current?.gotoLine(note.restore.line, { focus: false, align: 'start' }); return; }
    let stop = false;
    let raf = 0;
    const t0 = performance.now();
    const halt = () => { stop = true; };
    stopRestore.current = halt;
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    for (const e of events) el.addEventListener(e, halt, { passive: true });
    const tick = () => {
      if (stop) return;
      el.scrollTop = top;
      if (performance.now() - t0 < 1000) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { stop = true; cancelAnimationFrame(raf); for (const e of events) el.removeEventListener(e, halt); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.restore, s.scrollRef]);

  // A hit position (search hit, `[[note#heading]]`): Write mode puts the cursor there, Read mode scrolls
  // to the block and highlights it. Once per hit, so toggling the mode doesn't jump back.
  const handledGoto = useRef(0);
  useEffect(() => {
    const g = note?.goto;
    if (!g || g.nonce === handledGoto.current) return;
    handledGoto.current = g.nonce;
    if (mode === 'write') { editor.current?.gotoLine(g.line); return; }
    const sc = s.scrollRef.current;
    const b = sc && scrollToLine(sc, g.line, 'center');
    if (!b) return;
    b.classList.add('hit');
    const t = setTimeout(() => b.classList.remove('hit'), 1500);
    return () => clearTimeout(t);
  }, [note?.goto, mode, note?.loadNonce, s.scrollRef]);

  // Switching mode keeps the place: the outgoing view's top line is shown at the top of the incoming one.
  const pendingLine = useRef<number | null>(null);
  const switchMode = (m: 'write' | 'read') => {
    if (m === mode) return;
    stopRestore.current();
    const sc = s.scrollRef.current;
    pendingLine.current = (mode === 'write' ? editor.current?.topLine() : sc && topBlockLine(sc)) ?? null;
    setMode(m);
  };
  useEffect(() => {
    const line = pendingLine.current;
    pendingLine.current = null;
    const sc = s.scrollRef.current;
    if (line === null || !sc) return;
    if (mode === 'write') editor.current?.gotoLine(line, { focus: false, align: 'start' });
    else scrollToLine(sc, line, 'top');
  }, [mode, s.scrollRef]);
  // The editor opens with the current text (not `loaded`, which predates our own saves); it only
  // changes on (re)load or mode switch, so typing and saving never replace the editor's text (#101).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const editorDoc = useMemo(() => s.currentText(), [noteKey, note?.loadNonce, mode]);

  const canAttach = !!note && mode === 'write' && !note.binary && !readOnly && !note.deleted;
  /** Uploads files for the note and embeds them at `at` (default: the cursor). */
  const attach = (files: File[], fromCamera: boolean, at?: number) => {
    const ok = files.filter((f) => isUploadable(f.name) || /\.hei[cf]$/i.test(f.name));
    const refused = files.filter((f) => !ok.includes(f));
    if (refused.length) s.toast(`${refused.map((f) => f.name).join(', ')}: Only JPEG, PNG, GIF, WebP and PDF can be uploaded.`);
    const pos = editor.current?.track(at);
    if (pos && ok.length) void s.uploadToNote(ok, fromCamera, { insert: pos.insert, setText: (t) => editor.current?.setDoc(t) }).finally(pos.release);
    else pos?.release();
  };
  // A file dropped anywhere else is swallowed, so the browser doesn't navigate to it.
  useEffect(() => {
    const swallow = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    addEventListener('dragover', swallow);
    addEventListener('drop', swallow);
    return () => { removeEventListener('dragover', swallow); removeEventListener('drop', swallow); };
  }, []);

  // Properties form (#82): built from the editor's frontmatter text, so its positions are the editor's.
  const [fmText, setFmText] = useState<FrontmatterText | null>(null);
  const { schema } = s;
  // Outside the schema's folders the kinds come from the values.
  const rules = useMemo(() => (note && applies(schema, note.path) ? schema.fields : {}), [schema, note]);
  const fm = useMemo(() => (fmText ? parseProps(fmText.text, rules) : null), [fmText, rules]);
  const violations = useMemo(() => (fm && note ? validate({ ...fmText!, ...fm }, schema, note.path) : []), [fm, fmText, schema, note]);
  // The YAML lines for this note only (a refused edit, "Edit in YAML"), without changing the preference.
  const [yamlFor, setYamlFor] = useState<string | null>(null);
  useEffect(() => setYamlFor(null), [noteKey]);
  /** A form edit: computed on the frontmatter the form shows, written only while the editor still has that text. */
  const editProp = (e: Edit) => {
    if (!fmText) return;
    const r = editFrontmatter(fmText.text, e, rules);
    if ('refused' in r) { s.toast(r.refused); setYamlFor(note!.path); return; }
    const c = minimalChange(fmText.text, r.text);
    if (c) editor.current?.applyChange({ from: fmText.from + c.from, to: fmText.from + c.to, insert: c.insert }, fmText);
  };
  const names = useMemo(() => [...new Set(s.paths.filter((p) => /\.md$/i.test(p)).map((p) => p.split('/').pop()!.replace(/\.md$/i, '')))].sort(), [s.paths]);
  const showForm = mode === 'write' && !!note && !note.binary && !!fm && !fm.error && s.propsView !== 'yaml' && yamlFor !== note.path;

  const [outlineOpen, setOutlineOpen] = useState(false);
  const text = note && !note.binary ? s.currentText() : '';
  const outline = useMemo(() => (outlineOpen ? outlineOfText(text) : []), [outlineOpen, text]);
  // Note info: the selection when there is one, else the body; never the frontmatter. Read mode only counts
  // a selection inside the rendered note (the properties table is outside `.rd`).
  const [sel, setSel] = useState<string | null>(null);
  const readSelection = () => {
    if (mode === 'write') return editor.current?.selectionText() ?? null;
    const ds = getSelection();
    const rd = s.scrollRef.current?.querySelector('.rd');
    return ds && !ds.isCollapsed && rd?.contains(ds.anchorNode) && rd.contains(ds.focusNode) ? ds.toString() : null;
  };
  const selRef = useRef(readSelection);
  selRef.current = readSelection;
  useEffect(() => {
    if (!outlineOpen) return;
    const update = () => setSel(selRef.current());
    update();
    if (mode !== 'read') return;
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [outlineOpen, mode, text]);
  const info = useMemo(() => {
    if (!outlineOpen) return null;
    const c = countText(sel ?? splitFrontmatter(text).body);
    return { ...c, minutes: readingMinutes(c.words), selection: sel !== null };
  }, [outlineOpen, text, sel]);
  // The current section: the heading whose section holds the line at the top of the pane, while the outline is open.
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const sc = s.scrollRef.current;
    if (!outlineOpen || !sc) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = mode === 'write' ? editor.current?.topLine() : topBlockLine(sc);
      setCurrent(top === undefined ? -1 : currentHeading(outline, top));
    };
    const onScroll = () => { raf ||= requestAnimationFrame(update); };
    update();
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => { sc.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [outlineOpen, outline, mode, s.scrollRef]);

  // Phone and tablet close the outline on a note change; wide keeps it as a table of contents.
  useEffect(() => { if (!wide) setOutlineOpen(false); }, [noteKey, wide]);

  /** A jump is not a navigation: no history entry, the cursor stays, the phone keyboard stays closed. */
  const jumpTo = (line: number) => {
    stopRestore.current();
    if (!wide) setOutlineOpen(false);
    if (mode === 'write') { editor.current?.gotoLine(line, { focus: false, align: 'start' }); return; }
    const b = s.scrollRef.current && scrollToLine(s.scrollRef.current, line, 'top');
    if (!b) return;
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 1500);
  };

  const title = note ? note.path.split('/').pop()!.replace(/\.md$/i, '') : '';
  const del = () => { if (note && confirm(`Delete ${note.path}? It stays recoverable until you commit.`)) void s.deleteNote(); };

  return (
    <main className="pane always" id="detail" inert={inert} aria-label="Note">
      <header className="bar">
        {!phone && <button className="ib" title="Toggle sidebar" data-testid="sidebar-toggle" onClick={() => s.setSidebarOpen(!s.sidebarOpen)}><Icon n="sidebar_left" /></button>}
        {phone && <button className="ib back" data-testid="back" onClick={() => s.setPhoneNote(false)}><Icon n="chevron_left" size={24} /><span>{s.phoneTab === 'search' ? 'Search' : s.phoneTab === 'changes' ? 'Changes' : 'Files'}</span></button>}
        {note && !phone && <span className="crumb">{note.path.split('/').join(' › ')}</span>}
        <span className="sp" />
        {!wide && !phone && <GitPill small />}
        {note && (
          <>
            {!note.binary && <button className={`ib${outlineOpen ? ' on' : ''}`} title="Outline" aria-expanded={outlineOpen} data-testid="outline-button"
              onPointerDown={() => setSel(readSelection())} onClick={() => setOutlineOpen(!outlineOpen)}><Icon n="list_bullet" /></button>}
            {!note.binary && (
              <div className="seg" role="group" aria-label="Mode" data-testid="mode-toggle">
                <button className={mode === 'write' ? 'on' : ''} aria-pressed={mode === 'write'} data-testid="mode-write" onClick={() => switchMode('write')}>Write</button>
                <button className={mode === 'read' ? 'on' : ''} aria-pressed={mode === 'read'} data-testid="mode-read" onClick={() => switchMode('read')}>Read</button>
              </div>
            )}
            {canAttach && <AttachButton testid="attach" multiple onFiles={(files, fromCamera) => attach(files, fromCamera)} />}
            {mode === 'write' && !note.binary && <button className="ib" title="Find in note" data-testid="find-in-note" onClick={() => editor.current?.openSearch()}><Icon n="search" /></button>}
            <button className="ib" title={note.binary ? 'Delete file' : 'Delete note'} data-testid="delete-note" disabled={readOnly || note.deleted} onClick={del}><Icon n="trash" /></button>
          </>
        )}
        <button className={`ib${s.chatOpen && !phone ? ' on' : ''}`} title="AI chat" data-testid="chat-toggle"
          onClick={() => (phone ? s.setPhoneTab('chat') : s.setChatOpen(!s.chatOpen))}><Icon n="sparkles" /></button>
      </header>
      {outlineOpen && note && !note.binary && <OutlinePanel variant={phone ? 'sheet' : 'panel'} items={outline} info={info!} current={current} closeOutside={!phone && !wide}
        onJump={jumpTo} onClose={() => setOutlineOpen(false)} />}
      <div className="scroll" ref={s.scrollRef}>
        {!online && <div className="banner warn" data-testid="offline-banner">Offline — showing cached notes, read-only.</div>}
        {note?.deleted && (
          <div className="banner warn" data-testid="deleted-banner">
            This note was deleted by the AI, another device or a discard.{note.dirty ? ' Your unsaved changes are still here.' : ''}
            <span className="banner-acts">
              <button className="link" data-testid="deleted-keep" disabled={readOnly} onClick={() => void s.keepDeletedNote()}>Keep as new note</button>
              <button className="link" data-testid="deleted-close" onClick={s.closeDeletedNote}>Close</button>
            </span>
          </div>
        )}
        {online && conflict && <div className="banner warn" data-testid="conflict-banner">This vault is in conflict with GitHub — read-only until resolved in <button className="link" onClick={() => { s.setSection('changes'); s.setPhoneTab('changes'); s.setPhoneNote(false); s.setSidebarOpen(true); }}>Changes</button>.</div>}
        {noteIncoming && (
          <div className="banner" data-testid="incoming-note">
            Changed on GitHub · <PullLink idle="Pull" busy="Pulling…" />
          </div>
        )}
        {note?.binary ? (
          <MediaView key={note.path} path={note.path} />
        ) : note ? (
          <div className="doc">
            <h2 className="note-title">{title}</h2>
            {mode === 'write' && fm && (showForm
              ? <PropertiesPanel fm={fm} rules={rules} names={names} violations={violations} view={s.propsView === 'closed' ? 'closed' : 'open'}
                  disabled={readOnly || !!note.deleted} onView={s.setPropsView} onEdit={editProp} onYaml={() => setYamlFor(note.path)} />
              : fm.error
                ? <div className="props-bar" data-testid="props-unreadable">Can’t read these properties: {fm.error}</div>
                : <div className="props-bar"><button className="link" data-testid="props-form" onClick={() => { setYamlFor(null); if (s.propsView === 'yaml') s.setPropsView('open'); }}>Properties form</button></div>)}
            {mode === 'write'
              ? <Editor key={noteKey} ref={editor} doc={editorDoc} docNonce={note.loadNonce} readOnly={readOnly || !!note.deleted}
                  onChange={s.editDraft} exists={s.exists} onWikilink={s.followLink} resolveEmbed={rctx.resolveEmbed}
                  embedCtx={() => ({ vault: s.activeId!, toast: s.toast, onOpen: (p) => void s.openNote(p) })} mediaEpoch={s.mediaEpoch}
                  onDropFiles={canAttach ? (files, pos) => attach(files, false, pos) : undefined}
                  onSelection={() => { if (outlineOpen) setSel(readSelection()); }}
                  hideFrontmatter={showForm} onFrontmatter={setFmText} onRevealFrontmatter={() => setYamlFor(note.path)} />
              : <ReadView text={s.currentText()} />}
            <div className="dfoot" data-testid="save-state">
              {note.uploading ? 'Uploading…' : note.saving ? 'Saving…' : note.dirty ? '● Unsaved changes' : 'Saved'}{readOnly ? ' · read-only' : ''}
            </div>
          </div>
        ) : (
          <div className="placeholder">
            <img src="/icon-192.png" alt="" />
            {s.active?.state === 'clone-failed' ? (
              <p data-testid="clone-failed">Vault could not be cloned{s.active.error ? `: ${s.active.error}` : '.'}</p>
            ) : (
              <p>{s.usable ? 'Pick a note from the file tree.' : s.active ? `Vault is ${s.active.state}…` : 'Add a vault to get started.'}</p>
            )}
            {(!s.active || s.active.state === 'clone-failed') && (
              <button className="btn" data-testid="manage-vaults-cta" onClick={() => s.setAdminOpen('vaults', s.active?.id)}>{s.active ? 'Edit vault' : 'Manage vaults'}</button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
