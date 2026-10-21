// A fenced ```base block (#91) shown as a live, read-only table. Plain DOM (not React), so the Read-mode
// renderer and the CodeMirror widget both use it; text goes in with textContent, never as HTML.
import type { BaseCell, BaseResult } from '@karpathy/shared';
import { WIKILINK_RE, parseWikilink, wikilinkLabel } from './wikilink';
import { api, ApiError } from './api';

export interface BaseCtx {
  vault: string;
  /** Tap on a row: open that file. */
  open(path: string): void;
  /** Tap on a `[[wikilink]]` in a cell: follow it like a link in the note. */
  follow(inner: string): void;
}

type Outcome = { result: BaseResult } | { error: string };

/** Per vault: bumped by every change of its files, so cached results know they are stale. */
const epochs = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
/** The last outcome per vault and source, so a re-mounted block (a re-render, a streamed chat answer) shows at once. */
const cache = new Map<string, { epoch: number; outcome: Outcome }>();
const inflight = new Map<string, Promise<Outcome>>();

/** Files of `vault` changed (event stream): shown bases run again. */
export function baseChanged(vault: string) {
  epochs.set(vault, (epochs.get(vault) ?? 0) + 1);
  for (const l of listeners.get(vault) ?? []) l();
}

/** Tests: forget every cached result and mounted table. */
export function resetBases() {
  cache.clear();
  listeners.clear();
  inflight.clear();
  epochs.clear();
}

const keyOf = (vault: string, source: string) => `${vault}\n${source}`;

function message(e: unknown): string {
  if (e instanceof ApiError && e.code === 'base-unsupported') return e.message;
  if (e instanceof ApiError && e.code === 'base-invalid') return `Invalid base: ${e.message}`;
  return `Couldn't run this base: ${e instanceof Error ? e.message : String(e)}`;
}

function run(vault: string, source: string): Promise<Outcome> {
  const key = keyOf(vault, source);
  const epoch = epochs.get(vault) ?? 0;
  const running = inflight.get(key);
  if (running) return running;
  const p = api.base(vault, source).then((result): Outcome => ({ result }), (e: unknown): Outcome => ({ error: message(e) })).then((outcome) => {
    if (inflight.get(key) === p) inflight.delete(key);
    cache.set(key, { epoch, outcome });
    return outcome;
  });
  inflight.set(key, p);
  return p;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Text with `[[wikilinks]]` as links. */
function richText(parent: HTMLElement, s: string) {
  let at = 0;
  for (const m of s.matchAll(WIKILINK_RE)) {
    if (m.index > at) parent.append(s.slice(at, m.index));
    const a = el('a', 'wl', wikilinkLabel(parseWikilink(m[1]!)));
    a.href = '#';
    a.dataset.target = m[1]!;
    parent.append(a);
    at = m.index + m[0].length;
  }
  if (at < s.length) parent.append(s.slice(at));
}

function fillCell(td: HTMLElement, c: BaseCell) {
  if (c === null) return;
  if (Array.isArray(c)) {
    c.forEach((x, i) => {
      if (i) td.append(', ');
      fillCell(td, x);
    });
    return;
  }
  if (typeof c === 'object') {
    const a = el('a', 'base-link', c.text);
    a.href = '#';
    a.dataset.path = c.link;
    td.append(a);
    return;
  }
  if (typeof c === 'boolean') { td.append(c ? '☑' : '☐'); return; }
  if (typeof c === 'number') { td.classList.add('num'); td.append(String(c)); return; }
  richText(td, c);
}

function render(box: HTMLElement, o: Outcome, onEdit?: () => void) {
  const scroll = box.querySelector('.base-scroll');
  const left = scroll?.scrollLeft ?? 0;
  box.replaceChildren();
  const head = el('div', 'base-head');
  const title = el('span', 'base-title', 'result' in o && o.result.view ? o.result.view : 'Base');
  head.append(title);
  if (onEdit) {
    const b = el('button', 'ib sm base-edit', '</>');
    b.type = 'button';
    b.title = 'Edit the base';
    b.setAttribute('aria-label', 'Edit the base');
    b.dataset.testid = 'base-edit';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onEdit(); });
    head.append(b);
  }
  box.append(head);
  if ('error' in o) {
    const err = el('div', 'base-msg', o.error);
    err.dataset.testid = 'base-error';
    box.append(err);
    return;
  }
  const r = o.result;
  const wrap = el('div', 'base-scroll');
  wrap.tabIndex = 0;
  const table = el('table', 'base-table');
  const tr = el('tr');
  for (const c of r.columns) tr.append(el('th', undefined, c.label));
  table.append(el('thead'));
  table.tHead!.append(tr);
  const body = el('tbody');
  for (const row of r.rows) {
    const line = el('tr');
    line.dataset.path = row.path;
    row.cells.forEach((c) => {
      const td = el('td');
      fillCell(td, c);
      line.append(td);
    });
    body.append(line);
  }
  table.append(body);
  wrap.append(table);
  box.append(wrap);
  wrap.scrollLeft = left;
  const shown = r.rows.length;
  const count = shown === r.total ? `${shown} ${shown === 1 ? 'row' : 'rows'}` : `${shown} of ${r.total} rows`;
  box.append(el('div', 'base-foot', [count, ...r.notices].join(' · ')));
}

/**
 * Shows the base `source` in `host`: the last known result at once, then the current one; runs again whenever
 * the vault's files change. Returns the unmount function. `onEdit`: an Edit button (Write mode).
 */
export function mountBase(host: HTMLElement, source: string, ctx: BaseCtx, onEdit?: () => void): () => void {
  const box = el('div', 'base-view');
  box.dataset.testid = 'base-view';
  host.replaceChildren(box);
  box.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const wl = t.closest<HTMLElement>('a.wl');
    if (wl) { e.preventDefault(); e.stopPropagation(); ctx.follow(wl.dataset.target ?? ''); return; }
    const row = t.closest<HTMLElement>('a.base-link, tr[data-path]');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.open(row.dataset.path!);
  });
  let alive = true;
  const key = keyOf(ctx.vault, source);
  const refresh = () => void run(ctx.vault, source).then((o) => { if (alive) render(box, o, onEdit); });
  const hit = cache.get(key);
  if (hit) render(box, hit.outcome, onEdit);
  else box.append(el('div', 'base-msg muted', 'Loading…'));
  if (!hit || hit.epoch !== (epochs.get(ctx.vault) ?? 0)) refresh();
  // Several files change at once (a pull, an AI turn): one run after they settle.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
  const set = listeners.get(ctx.vault) ?? new Set();
  listeners.set(ctx.vault, set);
  set.add(onChange);
  return () => {
    alive = false;
    clearTimeout(timer);
    set.delete(onChange);
  };
}

/** Mounts every `.base-block[data-base]` placeholder of a rendered note. */
export function mountBases(root: HTMLElement, ctx: BaseCtx): () => void {
  const stops = [...root.querySelectorAll<HTMLElement>('.base-block[data-base]')].map((h) => mountBase(h, h.dataset.base ?? '', ctx));
  return () => stops.forEach((s) => s());
}
