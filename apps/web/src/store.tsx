import { MAX_UPLOAD_BYTES, rewriteLinks, WARN_UPLOAD_BYTES, type FileEntry, type SettingsView, type Vault, type VaultEvent, type VaultStatus } from '@karpathy/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, errorText } from './lib/api';
import { prepare } from './lib/attach';
import { draftAction, dropDraft, dropVaultDrafts, getDraft, putDraft } from './lib/drafts';
import { invalidate } from './lib/media';
import { readNdjson } from './lib/ndjson';
import { loadSortFilter, saveSortFilter, usesDates, type TreeSortFilter } from './lib/tree';
import { formatRoute, parseRoute } from './lib/route';
import { parseWikilink, resolveWikilink } from './lib/wikilink';

export type Section = 'files' | 'search' | 'changes';
export type PhoneTab = Section | 'chat';

export interface NoteView {
  path: string;
  /** Text last loaded from the server; changes only on (re)load, never on save. */
  loaded: string;
  loadNonce: number;
  version: string;
  dirty: boolean;
  saving: boolean;
  /** Files from the device are being uploaded for this note. */
  uploading?: boolean;
  /** The path the note was opened at, while it has moved since (into its own folder): keeps the editor mounted. */
  openedAs?: string;
  /** Deleted elsewhere (AI, another device, discard) while open. */
  deleted?: boolean;
  /** Not text (image, video, PDF…): shown as a player or file card (MediaView), never edited or saved (issue #20). */
  binary?: boolean;
  goto?: { line: number; nonce: number };
  /** Back to a note seen in this session: the scroll position it was left at. */
  restore?: { top: number; line?: number; nonce: number };
}

/** The open note's save state; `version` is the server version `saved` corresponds to. */
interface OpenNote { vault: string; path: string; version: string; saved: string; draft: string; deleted?: boolean; binary?: boolean }

const ACTIVE_KEY = 'karpathy.activeVault';
const CHAT_MAIN_KEY = 'karpathy.chatMain';
const MODE_KEY = 'karpathy.mode';
const AUTOSAVE_MS = 1500;
const RETRY_MS = 10_000;
const drafts = () => localStorage;

/** Mirrors the open note's unsaved text to localStorage (dropped once it is on the server). */
const persist = (n: OpenNote) => {
  if (n.draft === n.saved) dropDraft(drafts(), n.vault, n.path);
  else putDraft(drafts(), n.vault, n.path, { base: n.version, text: n.draft });
};
const isOpen = (n: OpenNote | null, st: { vault: string; path: string } | null) => !!st && !!n && n.vault === st.vault && n.path === st.path;

const headingLine = (text: string, heading: string) => {
  const i = text.split('\n').findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, '').trim() === heading);
  return i >= 0 ? i + 1 : undefined;
};

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  return online;
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const fn = () => setM(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [q]);
  return m;
}

/** Live vault event stream with reconnect (backoff, on visible, on online). */
function useVaultEvents(vaultId: string | null, enabled: boolean, onEvent: (vault: string, e: VaultEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!vaultId || !enabled) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const connect = async () => {
      clearTimeout(timer);
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      try {
        const res = await api.events(vaultId, c.signal);
        await readNdjson<VaultEvent>(res, (e) => { attempt = 0; if (!c.signal.aborted) handler.current(vaultId, e); });
      } catch (e) {
        if (c.signal.aborted || (e instanceof ApiError && e.status === 401)) return;
      }
      if (stopped || c.signal.aborted) return;
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
    };
    const wake = () => { if (document.visibilityState === 'visible') { attempt = 0; void connect(); } };
    void connect();
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl?.abort();
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('online', wake);
    };
  }, [vaultId, enabled]);
}

function useAppState() {
  const online = useOnline();
  const phone = useMedia('(max-width: 699px)');
  const wide = useMedia('(min-width: 1024px)');

  const [toastMsg, setToastMsg] = useState<{ text: string; n: number } | null>(null);
  const toast = useCallback((text: string) => setToastMsg({ text, n: Date.now() }), []);

  // ---- vaults + settings ----
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  // The URL (#/<vault>/<path>) wins over the stored vault; its note is opened once the vault is usable.
  const initialRoute = useRef(parseRoute(location.hash));
  const pendingRoute = useRef<{ vault: string; path: string } | null>(
    initialRoute.current.vault && initialRoute.current.path ? { vault: initialRoute.current.vault, path: initialRoute.current.path } : null);
  const [activeId, setActiveIdState] = useState<string | null>(() => initialRoute.current.vault ?? localStorage.getItem(ACTIVE_KEY));
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  /** Set below (forgetVault); the vault list effect needs it before the note state exists. */
  const vaultGone = useRef<(id: string) => void>(() => {});
  /**
   * Lists the server actually returned. Only such a list may declare a vault gone: the `[]` of a
   * failed fetch must not wipe its drafts. Keyed by the array itself, so overlapping fetches can't mix up.
   */
  const serverLists = useRef(new WeakSet<Vault[]>());
  const reloadVaults = useCallback(async () => {
    try {
      const list = await api.vaults();
      serverLists.current.add(list);
      setVaults(list);
    } catch (e) {
      toast(errorText(e));
      setVaults((v) => v ?? []);
    }
  }, [toast]);
  useEffect(() => {
    void reloadVaults();
    api.settings().then(setSettings).catch(() => {});
  }, [reloadVaults]);
  useEffect(() => {
    if (!vaults?.some((v) => v.state === 'cloning')) return;
    const t = setInterval(() => void reloadVaults(), 2000);
    return () => clearInterval(t);
  }, [vaults, reloadVaults]);
  const active = vaults?.find((v) => v.id === activeId) ?? null;
  // Fall back to the first vault when the stored one is gone (removed here or on another device).
  useEffect(() => {
    if (!vaults || active || !serverLists.current.has(vaults)) return;
    if (activeId && !vaults.some((v) => v.id === activeId)) vaultGone.current(activeId);
    if (vaults.length) setActiveIdState(vaults[0]!.id);
  }, [vaults, active, activeId]);
  useEffect(() => { if (activeId) localStorage.setItem(ACTIVE_KEY, activeId); }, [activeId]);
  const usable = !!active && (active.state === 'ready' || active.state === 'conflict');

  // ---- status, files ----
  // Tagged with its vault: a late response or event of the previous vault must not show up here (#22).
  const [statusOf, setStatusOf] = useState<{ vault: string; status: VaultStatus } | null>(null);
  const status = usable && statusOf?.vault === activeId ? statusOf.status : null;
  const setStatusFor = useCallback((vault: string, st: VaultStatus) => setStatusOf({ vault, status: st }), []);
  const setStatus = useCallback((st: VaultStatus) => { if (activeRef.current) setStatusFor(activeRef.current, st); }, [setStatusFor]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [changesNonce, setChangesNonce] = useState(0);
  /** Bumped when cached media bytes were dropped (their file changed): shown embeds remount. */
  const [mediaEpoch, setMediaEpoch] = useState(0);
  const paths = useMemo(() => files.filter((f) => f.type === 'file').map((f) => f.path), [files]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  // Listings can overlap (live refetches while the AI writes): only the newest request may set the tree.
  const filesReq = useRef(0);
  const refreshFiles = useCallback(async () => {
    if (!activeId) return;
    const req = ++filesReq.current;
    try {
      const f = await api.files(activeId);
      if (activeRef.current === activeId && req === filesReq.current) setFiles(f);
    } catch (e) { toast(errorText(e)); }
  }, [activeId, toast]);

  useEffect(() => {
    setStatusOf(null);
    setFiles([]);
  }, [activeId, usable]);
  // Going offline keeps the tree in memory (the refetch may fail without a cached copy).
  useEffect(() => {
    if (!usable || !activeId) return;
    if (online) api.open(activeId).then((st) => setStatusFor(activeId, st)).catch((e) => toast(errorText(e)));
    void refreshFiles();
  }, [activeId, usable, online, refreshFiles, toast, setStatusFor]);

  // ---- note + autosave ----
  // Unsaved text is mirrored to localStorage (lib/drafts) on every edit, so a reload, a closed tab
  // or a killed PWA never loses it; it is restored when the note is opened again.
  const [note, setNote] = useState<NoteView | null>(null);
  const noteRef = useRef<OpenNote | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<void> | null>(null);
  /** Why the last save of the open note failed: 'stale' and 'deleted' block leaving the note. */
  const failed = useRef<'stale' | 'deleted' | 'error' | null>(null);
  const [stale, setStale] = useState<{ vault: string; path: string } | null>(null);
  /** The note whose uploads are running: its autosave waits (the server may move it meanwhile). */
  const autosavePaused = useRef<OpenNote | null>(null);
  /** The next route sync replaces the history entry (the open note moved, it wasn't navigated to). */
  const replaceRoute = useRef(false);

  /** Resolves true when the open note's text is on the server (nothing to save counts). */
  const save = useCallback(async (force = false, keepalive = false): Promise<boolean> => {
    clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    const n = noteRef.current;
    if (!n || n.binary || (!force && n.draft === n.saved)) return true;
    if (n.deleted) { failed.current = 'deleted'; return false; }
    let ok = false;
    const text = n.draft;
    setNote((v) => v && { ...v, saving: true });
    inflight.current = api.putFile(n.vault, n.path, text, n.version, force, keepalive)
      .then((r) => {
        n.version = r.version;
        n.saved = text;
        ok = true;
        persist(n);
        if (noteRef.current !== n) return;
        if (failed.current === 'error') toast('Saved');
        failed.current = null;
        setStale((st) => (st?.vault === n.vault && st.path === n.path ? null : st));
        setNote((v) => v && { ...v, version: r.version, dirty: n.draft !== text });
      })
      .catch((e) => {
        if (noteRef.current !== n) return;
        if (e instanceof ApiError && e.status === 409) {
          failed.current = 'stale';
          setStale({ vault: n.vault, path: n.path });
          return;
        }
        if (e instanceof ApiError && e.status === 423) toast('Vault is in conflict — resolve it before editing');
        else if (failed.current !== 'error') toast(`Save failed: ${errorText(e)}`);
        failed.current = 'error';
        // The draft is kept locally; retry later (and on `online`, see below).
        if (navigator.onLine) timer.current = setTimeout(() => void save(false), RETRY_MS);
      })
      .finally(() => {
        inflight.current = null;
        setNote((v) => v && { ...v, saving: false });
      });
    await inflight.current;
    return ok;
  }, [toast]);

  const flush = useCallback(() => save(false), [save]);

  /** Flush before leaving the open note. False = stay: the save is stale or the note was deleted. */
  const leave = useCallback(async () => {
    if (await save(false)) return true;
    const n = noteRef.current;
    if (failed.current === 'stale' && n) setStale({ vault: n.vault, path: n.path });
    if (failed.current === 'deleted' && n) toast(`${n.path} was deleted — keep it as a new note or close it first`);
    // Other failures (offline, server error): the draft is stored locally and restored on reopen.
    return failed.current !== 'stale' && failed.current !== 'deleted';
  }, [save, toast]);

  // The user's pull (tap on the incoming count). Changed files arrive as files-changed events.
  // Tagged with its vault: a pull running in another vault doesn't disable this one's controls.
  const [pullingVault, setPullingVault] = useState<string | null>(null);
  const pulling = pullingVault !== null && pullingVault === activeId;
  const pullingRef = useRef<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pull = useCallback(async () => {
    const id = activeRef.current;
    // A ref, not state: a second tap in the same frame sees it before React re-renders.
    if (!id || pullingRef.current === id) return;
    pullingRef.current = id;
    setPullingVault(id);
    try {
      // The pending autosave must land first: the pull's stash protects saved text only.
      if (!(await leave())) return;
      const n = statusRef.current?.incomingCount ?? 0;
      const st = await api.pull(id);
      setStatusFor(id, st);
      if (st.pullError) toast("Couldn't reach GitHub");
      else if (st.state === 'ready' && activeRef.current === id) toast(`Pulled ${n} change${n === 1 ? '' : 's'} from GitHub`);
    } catch (e) { toast(errorText(e)); } finally {
      pullingRef.current = null;
      setPullingVault(null);
    }
  }, [leave, toast, setStatusFor]);

  /** The open note's current text, including unsaved edits and saves since it was loaded (#101). */
  const currentText = useCallback(() => noteRef.current?.draft ?? '', []);

  const editDraft = useCallback((text: string) => {
    const n = noteRef.current;
    if (!n || n.binary) return;
    n.draft = text;
    persist(n);
    setNote((v) => v && (v.dirty === (text !== n.saved) ? v : { ...v, dirty: text !== n.saved }));
    clearTimeout(timer.current);
    if (!n.deleted && autosavePaused.current !== n) timer.current = setTimeout(() => void save(false), AUTOSAVE_MS);
  }, [save]);

  /** Loads a note; a locally stored draft is restored (or, if the note changed since, goes stale). */
  const load = useCallback(async (path: string, line?: number, heading?: string): Promise<'ok' | 'missing' | 'error'> => {
    const vault = activeId;
    if (!vault) return 'error';
    try {
      const f = await api.file(vault, path);
      if (f.binary) {
        clearTimeout(timer.current);
        failed.current = null;
        noteRef.current = { vault, path, version: f.version, saved: '', draft: '', binary: true };
        setNote({ path, loaded: '', loadNonce: Date.now(), version: f.version, dirty: false, saving: false, binary: true });
        return 'ok';
      }
      const d = getDraft(drafts(), vault, path);
      const act = draftAction(d, f.version, f.content);
      if (act === 'none' && d) dropDraft(drafts(), vault, path);
      const text = act === 'none' ? f.content : d!.text;
      // Stale draft: keep its old base, so saving it goes through the stale-save flow.
      const version = act === 'stale' ? d!.base : f.version;
      clearTimeout(timer.current);
      failed.current = null;
      noteRef.current = { vault, path, version, saved: f.content, draft: text };
      if (heading) line = headingLine(text, heading) ?? line;
      setNote({ path, loaded: text, loadNonce: Date.now(), version, dirty: text !== f.content, saving: false, ...(line ? { goto: { line, nonce: Date.now() } } : {}) });
      if (act === 'restore') {
        toast('Restored unsaved changes');
        timer.current = setTimeout(() => void save(false), AUTOSAVE_MS);
      }
      if (act === 'stale') setStale({ vault, path });
      return 'ok';
    } catch (e) {
      const missing = e instanceof ApiError && e.status === 404;
      toast(missing ? `No page “${path}”` : errorText(e));
      return missing ? 'missing' : 'error';
    }
  }, [activeId, toast, save]);

  // Leaving the page (reload, tab closed, PWA backgrounded/killed): flush now; warn while unsaved.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') void save(false, true); };
    const pagehide = () => void save(false, true);
    const beforeunload = (e: BeforeUnloadEvent) => {
      const n = noteRef.current;
      if (n && n.draft !== n.saved) { e.preventDefault(); e.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', hide);
    addEventListener('pagehide', pagehide);
    addEventListener('beforeunload', beforeunload);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      removeEventListener('pagehide', pagehide);
      removeEventListener('beforeunload', beforeunload);
    };
  }, [save]);

  // Back online: retry a save that failed meanwhile.
  useEffect(() => {
    const n = noteRef.current;
    if (online && n && n.draft !== n.saved && failed.current !== 'stale') void save(false);
  }, [online, save]);

  /** The open note `n` was moved into its own folder by an upload: follow it (path, draft key, route). */
  const retarget = useCallback(async (n: OpenNote, to: string, rewritten: string[], setText: (text: string) => void) => {
    const from = n.path;
    const paths = pathsRef.current; // still the list from before the move
    dropDraft(drafts(), n.vault, from);
    n.path = to;
    try {
      // The server rewrote the page's relative links one level deeper: unedited, take its text; edited, rewrite ours the same way.
      const f = await api.file(n.vault, to);
      n.version = f.version;
      n.draft = n.draft === n.saved ? f.content : rewriteLinks(n.draft, from, from, to, paths);
      n.saved = f.content;
    } catch { /* the next save goes through the stale-save flow */ }
    // Into the editor now, before the embed goes in (an insert reports the editor's whole text as the draft).
    if (noteRef.current === n) setText(n.draft);
    persist(n);
    if (noteRef.current !== n) return;
    replaceRoute.current = true;
    setNote((v) => v && { ...v, path: to, openedAs: v.openedAs ?? from, version: n.version, dirty: n.draft !== n.saved });
    void refreshFiles();
    const k = rewritten.length;
    toast(`Moved to ${to}${k ? ` · updated links in ${k} page${k === 1 ? '' : 's'}` : ''}`);
  }, [refreshFiles, toast]);

  /**
   * Uploads files from the device for the open note, one after another, and hands each stored file's
   * name to `insert` (the editor puts the embed in). A file that fails is skipped with a toast.
   */
  const uploadToNote = useCallback(async (list: File[], fromCamera: boolean, editor: { insert(embed: string): boolean; setText(text: string): void }) => {
    const n = noteRef.current;
    if (!n || n.binary || !list.length) return;
    if (!(await save(false))) { toast('Save the note first'); return; }
    autosavePaused.current = n;
    /** The editor is gone (Read mode, another note): the embed goes on a line at the end of the note's text. */
    const append = (embed: string) => {
      n.draft = `${n.draft}${!n.draft || n.draft.endsWith('\n') ? '' : '\n'}${embed}\n`;
      persist(n);
      if (noteRef.current === n) setNote((v) => v && { ...v, loadNonce: Date.now(), dirty: true });
    };
    setNote((v) => v && { ...v, uploading: true });
    try {
      for (const file of list) {
        try {
          const { blob, name } = await prepare(file, fromCamera);
          if (blob.size > MAX_UPLOAD_BYTES) { toast(`${file.name} is larger than 50 MB and can’t be uploaded.`); continue; }
          const mb = Math.round(blob.size / 2 ** 20);
          if (blob.size > WARN_UPLOAD_BYTES && !confirm(`${file.name} adds ${mb} MB to the vault’s git history for good, even if you delete it later. Upload anyway?`)) continue;
          const r = await api.upload(n.vault, name, { note: n.path }, blob);
          if (r.moved) await retarget(n, r.moved.to, r.rewritten ?? [], editor.setText);
          // Known at once, so the embed resolves before the file event arrives.
          if (activeRef.current === n.vault) setFiles((f) => (f.some((x) => x.path === r.path) ? f : [...f, { path: r.path, type: 'file' }]));
          const embed = `![[${r.path.split('/').pop()}]]`;
          if (noteRef.current !== n || !editor.insert(embed)) append(embed);
        } catch (e) {
          toast(`${file.name}: ${errorText(e)}`);
        }
      }
    } finally {
      if (autosavePaused.current === n) autosavePaused.current = null;
      setNote((v) => v && { ...v, uploading: false });
      if (n.draft !== n.saved) {
        if (noteRef.current === n) timer.current = setTimeout(() => void save(false), AUTOSAVE_MS);
        // Left meanwhile: save it here, the way leaving it would have.
        else void api.putFile(n.vault, n.path, n.draft, n.version).then((r) => { n.version = r.version; n.saved = n.draft; persist(n); }, (e) => toast(`Save failed: ${errorText(e)}`));
      }
    }
  }, [save, toast, retarget]);

  // ---- UI state ----
  const [section, setSection] = useState<Section>('files');
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('files');
  // Phone: each tab has its own push stack; the note is pushed onto the tab it was opened from.
  const [noteTab, setNoteTab] = useState<PhoneTab | null>(null);
  const phoneNote = noteTab !== null && noteTab === phoneTab;
  const setPhoneNote = useCallback((on: boolean) => setNoteTab(on ? phoneTab : null), [phoneTab]);
  // Narrowing into the phone layout with a note open keeps the note pushed (#104).
  // Only a real wide/tablet → phone transition counts, not the mount or a re-run of the effect.
  const wasPhone = useRef(phone);
  useEffect(() => {
    const narrowed = phone && !wasPhone.current;
    wasPhone.current = phone;
    if (narrowed && noteRef.current) setNoteTab((t) => t ?? (phoneTab === 'chat' ? 'files' : phoneTab));
  }, [phone, phoneTab]);
  const [chatOpen, setChatOpen] = useState(() => innerWidth >= 1280);
  // Wide layout: which of note and chat is in the main column (the other is in the 380 px side column).
  // Per-browser preference; storage can throw (private mode, blocked site data): default to note in main.
  const [chatMain, setChatMain] = useState(() => { try { return localStorage.getItem(CHAT_MAIN_KEY) === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(CHAT_MAIN_KEY, chatMain ? '1' : '0'); } catch { /* not remembered */ } }, [chatMain]);
  const [sidebarOpen, setSidebarOpen] = useState(wide);
  // Wide: the sidebar is a column (shown by default); tablet: an overlay (hidden by default).
  useEffect(() => setSidebarOpen(wide), [wide]);
  // The mode is a per-browser preference: only the toggle changes it, no navigation does. Storage can throw (private mode).
  const [mode, setModeState] = useState<'write' | 'read'>(() => { try { return localStorage.getItem(MODE_KEY) === 'read' ? 'read' : 'write'; } catch { return 'write'; } });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setMode = useCallback((m: 'write' | 'read') => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* not remembered */ }
  }, []);
  // Tree sort and filter (#122): per-browser preference for all vaults.
  const [sortFilter, setSortFilterState] = useState(() => loadSortFilter(localStorage));
  const sortFilterRef = useRef(sortFilter);
  sortFilterRef.current = sortFilter;
  const setSortFilter = useCallback((v: TreeSortFilter) => {
    setSortFilterState(v);
    saveSortFilter(localStorage, v);
    // Without dates in use, modifications don't refetch the listing: its dates may be stale.
    if (usesDates(v)) void refreshFiles();
  }, [refreshFiles]);
  /** Open admin modal: the vaults dialog (`vault` opens that vault's details instead of the list) or the settings dialog. */
  const [adminOpen, setAdminOpenState] = useState<false | { view: 'vaults'; vault?: string } | { view: 'settings' }>(false);
  const setAdminOpen = useCallback((open: false | 'vaults' | 'settings', vault?: string) =>
    setAdminOpenState(open === false ? false : open === 'settings' ? { view: 'settings' } : { view: 'vaults', vault }), []);
  const [commitOpen, setCommitOpen] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);

  /** The pane's scroll element, set by NotePane; read when a note is left, to remember its place. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Where each note seen in this session was left (in memory only), for Back. */
  const places = useRef(new Map<string, { top: number; line?: number; mode: 'write' | 'read' }>());
  /** Set by NotePane: the open view's place. Write mode also reports its top line (CodeMirror's pixel heights are estimates). */
  const placeNow = useRef<(() => { top: number; line?: number }) | null>(null);
  /** Set by the Back/Forward handler: the next opened note returns to its remembered place. */
  const restorePlace = useRef(false);

  const openNote = useCallback(async (path: string, line?: number, heading?: string) => {
    const cur = noteRef.current;
    if (cur?.path === path) {
      const l = heading ? headingLine(cur.draft, heading) : line;
      if (l) setNote((v) => v && { ...v, goto: { line: l, nonce: Date.now() } });
    } else {
      if (cur && placeNow.current) places.current.set(`${cur.vault}\0${cur.path}`, { ...placeNow.current(), mode: modeRef.current });
      if (!(await leave())) return;
      if ((await load(path, line, heading)) !== 'ok') return;
      const place = restorePlace.current ? places.current.get(`${activeId}\0${path}`) : undefined;
      if (place && place.mode === modeRef.current) setNote((v) => v && { ...v, restore: { top: place.top, line: place.line, nonce: Date.now() } });
    }
    if (phone) {
      const tab = phoneTab === 'chat' ? 'files' : phoneTab;
      setPhoneTab(tab);
      setNoteTab(tab);
    } else if (!wide) {
      setSidebarOpen(false);
      setChatOpen(false);
    }
  }, [leave, load, phone, wide, phoneTab, activeId]);

  /** The user is editing (checked when an AI open would switch the note): editor focused or unsaved text. */
  const isEditing = useCallback(() => {
    const n = noteRef.current;
    return !!n && (n.draft !== n.saved || !!document.activeElement?.closest('.cm-editor'));
  }, []);

  const dropNote = useCallback(() => {
    clearTimeout(timer.current);
    noteRef.current = null;
    setNote(null);
    setNoteTab(null);
  }, []);

  /** A vault was removed: forget its drafts; if it was active, drop its note and chat unsaved (issue #24). */
  const forgetVault = useCallback((id: string) => {
    dropVaultDrafts(drafts(), id);
    if (noteRef.current?.vault === id) { failed.current = null; setStale(null); dropNote(); }
    if (activeRef.current === id) { setChatId(null); pendingRoute.current = null; }
  }, [dropNote]);
  vaultGone.current = forgetVault;

  const closeNote = useCallback(async () => {
    if (!(await leave())) return false;
    dropNote();
    return true;
  }, [leave, dropNote]);

  const followLink = useCallback((inner: string) => {
    const l = parseWikilink(inner);
    if (!l.target) {
      if (l.heading && noteRef.current) void openNote(noteRef.current.path, undefined, l.heading);
      return;
    }
    const p = resolveWikilink(l.target, pathsRef.current, noteRef.current?.path);
    if (p) void openNote(p, undefined, l.heading);
    else toast(`No page “${l.target}” yet`);
  }, [openNote, toast]);

  // Changes with the file list, so rendered links re-check which pages exist (#55).
  const exists = useCallback((target: string) => resolveWikilink(target, paths) !== null, [paths]);

  /** Stale dialog: drop my edits of the stale note (and show the server version if it is open). */
  const reloadNote = useCallback(async () => {
    const st = stale;
    setStale(null);
    if (!st) return;
    dropDraft(drafts(), st.vault, st.path);
    if (!isOpen(noteRef.current, st)) return;
    clearTimeout(timer.current);
    if ((await load(st.path)) === 'missing') dropNote();
  }, [stale, load, dropNote]);

  /** Stale dialog: force-save my text of the stale note. */
  const overwriteNote = useCallback(async () => {
    const st = stale;
    if (!st) return false;
    if (isOpen(noteRef.current, st)) return save(true);
    setStale(null);
    const d = getDraft(drafts(), st.vault, st.path);
    if (!d) return true;
    try {
      await api.putFile(st.vault, st.path, d.text, d.base, true);
      dropDraft(drafts(), st.vault, st.path);
      return true;
    } catch (e) {
      toast(`Save failed: ${errorText(e)}`);
      return false;
    }
  }, [stale, save, toast]);

  /** Deleted-note banner: recreate the note with the current text. */
  const keepDeletedNote = useCallback(async () => {
    const n = noteRef.current;
    if (!n?.deleted) return;
    const text = n.draft;
    try {
      const r = await api.putFile(n.vault, n.path, text, null);
      n.deleted = false;
      n.version = r.version;
      n.saved = text;
      failed.current = null;
      persist(n);
      setNote((v) => v && { ...v, deleted: false, version: r.version, dirty: n.draft !== text });
      void refreshFiles();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? `${n.path} exists again — reopen it` : errorText(e));
    }
  }, [refreshFiles, toast]);

  /** Deleted-note banner: close it (dropping unsaved edits). */
  const closeDeletedNote = useCallback(() => {
    const n = noteRef.current;
    if (n) dropDraft(drafts(), n.vault, n.path);
    dropNote();
  }, [dropNote]);

  const deleteNote = useCallback(async () => {
    const n = noteRef.current;
    if (!n || !activeId) return;
    try {
      clearTimeout(timer.current);
      await api.deleteFile(activeId, n.path, n.version);
      dropDraft(drafts(), n.vault, n.path);
      dropNote();
      toast(`Deleted ${n.path}`);
      void refreshFiles();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? 'The note changed since it was loaded — reload it first' : errorText(e));
    }
  }, [activeId, refreshFiles, toast, dropNote]);

  const newNote = useCallback(async (path: string) => {
    if (!activeId) return;
    const title = path.split('/').pop()!.replace(/\.md$/i, '');
    try {
      await api.putFile(activeId, path, `# ${title}\n`, null);
      await refreshFiles();
      await openNote(path);
    } catch (e) {
      toast(e instanceof ApiError && (e.code === 'exists-case' || e.code === 'bad-name') ? `Can’t create ${path}: ${e.message}` : e instanceof ApiError && e.status === 409 ? `${path} already exists` : errorText(e));
    }
  }, [activeId, refreshFiles, openNote, toast]);

  // Switching vaults: flush and drop the open note and chat; `path` = note to open there (history).
  const setActiveId = useCallback(async (id: string, path?: string | null) => {
    if (!(await leave())) return;
    dropNote();
    setChatId(null);
    if (activeRef.current) invalidate(activeRef.current);
    pendingRoute.current = path ? { vault: id, path } : null;
    setActiveIdState(id);
  }, [leave, dropNote]);

  // ---- URL: #/<vault>/<path> (Back/Forward, reload) ----
  const syncRoute = useCallback((replace = false) => {
    if (pendingRoute.current) return;
    const h = formatRoute(activeRef.current, noteRef.current?.path);
    if (location.hash === h) return;
    const url = h || location.pathname + location.search;
    if (replace || !location.hash) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }, []);
  useEffect(() => {
    syncRoute(replaceRoute.current);
    replaceRoute.current = false;
  }, [activeId, note?.path, syncRoute]);

  // Open the note from the URL once its vault is usable.
  useEffect(() => {
    const p = pendingRoute.current;
    if (!p || !vaults) return;
    if (p.vault !== activeId || (active && active.state === 'clone-failed')) { pendingRoute.current = null; syncRoute(true); return; }
    if (!usable) return;
    pendingRoute.current = null;
    void openNote(p.path).then(() => syncRoute(true));
  }, [vaults, active, activeId, usable, openNote, syncRoute]);

  useEffect(() => {
    const onPop = async () => {
      const r = parseRoute(location.hash);
      if (!r.vault) return;
      if (r.vault !== activeRef.current) await setActiveId(r.vault, r.path);
      else if (r.path && r.path !== noteRef.current?.path) {
        restorePlace.current = true;
        try { await openNote(r.path); } finally { restorePlace.current = false; }
      }
      else if (!r.path && noteRef.current) await closeNote();
      else if (r.path && phone) setNoteTab(phoneTab === 'chat' ? 'files' : phoneTab);
      // Blocked (stale save) or failed: the URL shows what is actually open.
      syncRoute(true);
    };
    const h = () => void onPop();
    addEventListener('popstate', h);
    return () => removeEventListener('popstate', h);
  }, [setActiveId, openNote, closeNote, syncRoute, phone, phoneTab]);

  // ---- event stream ----
  // While the tree sorts or filters by date (#122), a modification changes the order: refetch the
  // listing, once per burst. The AI's stamp can land after its write event, so a turn's end refetches too.
  const datesTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastBusy = useRef<string | undefined>(undefined);
  const refreshDatesSoon = useCallback(() => {
    if (!usesDates(sortFilterRef.current)) return;
    clearTimeout(datesTimer.current);
    datesTimer.current = setTimeout(() => void refreshFiles(), 500);
  }, [refreshFiles]);
  const onEvent = useCallback((vault: string, e: VaultEvent) => {
    if (vault !== activeRef.current) return;
    if (e.type === 'status') {
      if (lastBusy.current === 'turn' && e.status.busy !== 'turn') refreshDatesSoon();
      lastBusy.current = e.status.busy;
      setStatusFor(vault, e.status);
      setChangesNonce((x) => x + 1);
      return;
    }
    setChangesNonce((x) => x + 1);
    if (e.files.some((f) => f.version === null || !pathsRef.current.includes(f.path))) void refreshFiles();
    else refreshDatesSoon();
    // Cached media bytes of a changed file are stale: drop them and let the shown embeds fetch again.
    if (invalidate(vault, e.files.map((f) => f.path)) > 0) setMediaEpoch((n) => n + 1);
    const n = noteRef.current;
    const hit = n && e.files.find((f) => f.path === n.path);
    if (!n || !hit || hit.version === n.version) return;
    if (hit.version === null) {
      // Banner in NotePane: close it or keep it as a new note. No autosave meanwhile.
      clearTimeout(timer.current);
      n.deleted = true;
      setNote((v) => v && { ...v, deleted: true });
      return;
    }
    if (n.deleted) {
      // Recreated elsewhere: a save now goes through the stale-save flow.
      n.deleted = false;
      setNote((v) => v && { ...v, deleted: false });
    }
    // Unsaved changes are kept; the stale-save flow handles them on the next save.
    if (n.draft === n.saved && !inflight.current) {
      void load(n.path).then((r) => r === 'ok' && toast('Updated by AI or another device'));
    }
  }, [refreshFiles, refreshDatesSoon, load, toast, setStatusFor]);
  useVaultEvents(usable ? activeId : null, online, onEvent);

  const conflict = status?.state === 'conflict';
  const readOnly = !online || conflict;

  return {
    online, phone, wide, toast, toastMsg,
    vaults, reloadVaults, settings, setSettings, active, activeId, setActiveId, usable,
    status, setStatus, pull, pulling, files, paths, refreshFiles, changesNonce, mediaEpoch,
    note, currentText, openNote, isEditing, closeNote, forgetVault, editDraft, flush, uploadToNote, reloadNote, overwriteNote, deleteNote, newNote, stale, setStale,
    keepDeletedNote, closeDeletedNote,
    followLink, exists, readOnly, conflict,
    section, setSection, phoneTab, setPhoneTab, phoneNote, setPhoneNote, chatOpen, setChatOpen, chatMain, setChatMain,
    sidebarOpen, setSidebarOpen, mode, setMode, sortFilter, setSortFilter, scrollRef, placeNow, adminOpen, setAdminOpen, commitOpen, setCommitOpen, chatId, setChatId,
  };
}

export type AppState = ReturnType<typeof useAppState>;
const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const s = useAppState();
  // Logging out (or any unmount) drops every cached media blob.
  useEffect(() => () => { invalidate(); }, []);
  return <Ctx.Provider value={s}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useApp outside AppProvider');
  return s;
}
