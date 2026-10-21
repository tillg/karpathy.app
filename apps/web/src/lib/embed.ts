// Mounts what an embed refers to into a placeholder: a player, or a file card. Plain DOM (not React) so
// the Read-mode renderer, the chat and the CodeMirror widget all use it. Elements are created with
// createElement and an object URL as `src`: no HTML strings, so nothing reaches the DOM unsanitized.
import { isPdf } from '@karpathy/shared';
import { fileSize, knownNatural, objectUrl, rememberNatural, type Resolved } from './media';

export interface EmbedCtx {
  vault: string;
  toast: (text: string) => void;
  /** Tap on an image: open that file in the note pane. */
  onOpen?: (path: string) => void;
}

const name = (path: string) => path.split('/').pop()!;
const mb = (n: number) => `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;
export const human = (n: number) => (n >= 1024 * 1024 ? mb(n) : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (label: string, testid: string, onClick: () => void) => {
  const b = el('button', 'btn g sm', label);
  b.type = 'button';
  b.dataset.testid = testid;
  b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
  return b;
};

/** Saves the file through a temporary link; goes through the cache like a preview. */
async function download(ctx: EmbedCtx, path: string) {
  try {
    const r = await objectUrl(ctx.vault, path, { force: true });
    if ('tooLarge' in r) return;
    const a = el('a');
    a.href = r.url;
    a.download = name(path);
    a.click();
    r.release();
  } catch (e) { ctx.toast(`Download failed: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Opens a PDF in the browser's viewer in a new tab. `window.open` must run in the click itself
 * (Safari blocks one after an await); the tab gets a blob typed `application/pdf` by us, not by the response.
 */
async function openPdf(ctx: EmbedCtx, path: string) {
  const tab = window.open('', '_blank');
  if (!tab) { ctx.toast('Pop-up blocked: allow pop-ups for this site to open the PDF'); return; }
  try {
    const r = await objectUrl(ctx.vault, path, { force: true });
    if ('tooLarge' in r) throw new Error('too large');
    // (No fetch of the blob: connect-src would refuse it. The cache keeps the Blob next to its URL.)
    const url = URL.createObjectURL(new Blob([r.blob], { type: 'application/pdf' }));
    r.release();
    tab.location.href = url;
    // The tab has loaded it by then; a later reload of that tab fails, which is fine for a viewer tab.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    tab.close();
    ctx.toast(`Open failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CardOpts {
  /** A line after the name, e.g. "Not found" or "offline". */
  note?: string;
  size?: number | null;
  open?: boolean;
  download?: boolean;
  /** "Load anyway (N MB)": shows the media despite its size. */
  load?: () => void;
  miss?: boolean;
  testid?: string;
}

/** Name, size and the buttons that make sense: Open (PDF), Download, Load anyway. */
export function fileCard(ctx: EmbedCtx, path: string, o: CardOpts = {}): HTMLElement {
  const card = el('div', `file-card${o.miss ? ' miss' : ''}`);
  card.dataset.testid = o.testid ?? 'file-card';
  card.dataset.path = path;
  card.append(el('span', 'fc-name', name(path)));
  const meta = [o.size != null ? human(o.size) : '', o.note ?? ''].filter(Boolean).join(' · ');
  if (meta) card.append(el('span', 'fc-meta', meta));
  const acts = el('span', 'fc-acts');
  if (o.load) acts.append(button(`Load anyway (${mb(o.size ?? 0)})`, 'file-load', o.load));
  if (o.open) acts.append(button('Open', 'file-open', () => void openPdf(ctx, path)));
  if (o.download !== false && !o.miss) acts.append(button('Download', 'file-download', () => void download(ctx, path)));
  if (acts.childElementCount) card.append(acts);
  return card;
}

/** Fills the size in once the HEAD answers. */
function withSize(card: HTMLElement, vault: string, path: string, alive: () => boolean) {
  void fileSize(vault, path).then((n) => {
    if (n === null || !alive() || card.querySelector('.fc-meta')) return;
    const m = el('span', 'fc-meta', human(n));
    card.querySelector('.fc-name')!.after(m);
  });
}

const failNote = () => (navigator.onLine ? 'could not be loaded' : 'offline');

/** Ends an embed: stops late async work and frees its cached bytes. */
export type Stop = (() => void) & { moveTo: (host: HTMLElement) => void };

/** Mounts `r` into `host`. */
export function mountEmbed(host0: HTMLElement, r: Extract<Resolved, { state: 'media' | 'file' | 'missing' }>, ctx: EmbedCtx): Stop {
  let host = host0;
  let alive = true;
  let release: (() => void) | undefined;
  // `moveTo`: the same player continues in another placeholder (a re-render of the same text).
  const stop: Stop = Object.assign(() => { alive = false; release?.(); }, { moveTo: (h: HTMLElement) => { host = h; } });
  const show = (n: Node) => { if (alive) host.replaceChildren(n); };
  host.classList.remove('miss');
  host.classList.add('mounted');

  if (r.state === 'missing') {
    host.classList.add('miss');
    host.replaceChildren(fileCard(ctx, r.target, { miss: true, note: 'not found' }));
    return stop;
  }
  if (r.state === 'file') {
    const pdf = isPdf(r.path);
    const card = fileCard(ctx, r.path, { open: pdf });
    host.replaceChildren(card);
    withSize(card, ctx.vault, r.path, () => alive);
    return stop;
  }

  // media: a skeleton holds the space while the bytes load (the known shape of the file, else a default).
  const sk = el('div', 'embed-skel');
  const nat = knownNatural(ctx.vault, r.path);
  if (r.kind === 'audio') sk.style.height = '54px';
  else {
    // The shape the player will have: its natural size (capped by the width suffix), else a guess.
    sk.style.aspectRatio = nat ? `${nat.w} / ${nat.h}` : '4 / 3';
    sk.style.width = nat ? `${Math.min(nat.w, r.width ?? nat.w)}px` : r.width ? `${r.width}px` : '100%';
    sk.style.maxWidth = '100%';
  }
  host.replaceChildren(sk);

  const card = (o: CardOpts) => {
    const c = fileCard(ctx, r.path, o);
    show(c);
    if (o.size == null) withSize(c, ctx.vault, r.path, () => alive);
  };
  const place = (url: string) => {
    let m: HTMLImageElement | HTMLVideoElement | HTMLAudioElement;
    if (r.kind === 'image') {
      const img = el('img');
      img.alt = r.alt ?? name(r.path);
      // The size of a file seen before is known: the image has its final height before it is decoded (a restored scroll position depends on it).
      if (nat) img.style.aspectRatio = `${nat.w} / ${nat.h}`;
      img.addEventListener('load', () => rememberNatural(ctx.vault, r.path, img.naturalWidth, img.naturalHeight));
      // Inside a link, the link wins (`[![](a.png)](https://…)`).
      if (ctx.onOpen && !host.closest('a')) {
        img.classList.add('zoomable');
        img.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); ctx.onOpen!(r.path); });
      }
      m = img;
    } else if (r.kind === 'video') {
      const v = el('video');
      v.controls = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.addEventListener('loadedmetadata', () => rememberNatural(ctx.vault, r.path, v.videoWidth, v.videoHeight));
      m = v;
    } else {
      const a = el('audio');
      a.controls = true;
      a.preload = 'metadata';
      m = a;
    }
    m.src = url;
    if (r.width) m.style.maxWidth = `min(${r.width}px, 100%)`;
    // A broken image becomes a file card. A player that can't play (codec) keeps its own error message and gets the card below it, for Download.
    if (r.kind === 'image') m.addEventListener('error', () => card({ note: 'can’t be shown here' }));
    else {
      m.addEventListener('error', () => {
        if (!alive || host.querySelector('.file-card')) return;
        host.append(fileCard(ctx, r.path, { note: 'can’t be played here' }));
      });
    }
    show(m);
  };
  const load = (force: boolean) => {
    objectUrl(ctx.vault, r.path, { force }).then((res) => {
      if ('tooLarge' in res) {
        if (alive) card({ size: res.size, load: () => { host.replaceChildren(sk); load(true); } });
        return;
      }
      if (!alive) { res.release(); return; }
      release?.();
      release = res.release;
      place(res.url);
    }, () => { if (alive) card({ note: failNote() }); });
  };
  load(false);
  return stop;
}

/** One mounted placeholder: `key` identifies what it shows, so a re-render of the same text can keep it. */
export interface Mounted { key: string; host: HTMLElement; stop: Stop }

/**
 * Mounts every placeholder of a rendered note into its element. `prev` = what the previous render of the
 * same text mounted: an embed that is still there (same file, width, caption) keeps its player, so a chat
 * answer streaming in doesn't reset a playing video. Returns what is mounted now.
 */
export function mountEmbeds(root: HTMLElement, ctx: EmbedCtx, prev: Mounted[] = []): Mounted[] {
  const old = [...prev];
  const out: Mounted[] = [];
  for (const h of root.querySelectorAll<HTMLElement>('.embed')) {
    const kind = h.dataset.kind;
    const key = JSON.stringify([h.className, kind, h.dataset.path, h.dataset.width, h.dataset.alt, h.dataset.target, h.closest('a') !== null]);
    const i = old.findIndex((m) => m.key === key);
    if (i >= 0) {
      const [m] = old.splice(i, 1);
      h.replaceChildren(...m!.host.childNodes);
      h.classList.add('mounted');
      m!.stop.moveTo(h);
      out.push({ key, host: h, stop: m!.stop });
      continue;
    }
    let stop: Stop | undefined;
    if (h.classList.contains('miss')) stop = mountEmbed(h, { state: 'missing', target: h.dataset.target ?? '' }, ctx);
    else if (kind === 'file') stop = mountEmbed(h, { state: 'file', path: h.dataset.path ?? '' }, ctx);
    else if (kind === 'image' || kind === 'video' || kind === 'audio') {
      stop = mountEmbed(h, { state: 'media', path: h.dataset.path ?? '', kind, ...(h.dataset.width ? { width: Number(h.dataset.width) } : {}), ...(h.dataset.alt ? { alt: h.dataset.alt } : {}) }, ctx);
    }
    if (stop) out.push({ key, host: h, stop });
  }
  for (const m of old) m.stop();
  return out;
}
