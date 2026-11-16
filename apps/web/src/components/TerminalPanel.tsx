import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInfo } from '@karpathy/shared';
import { api, ApiError } from '../lib/api';
import { TerminalConnection } from '../lib/terminal';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * The terminal panel (#175), docked at the bottom like VS Code's: shells in the terminal service, started in the open
 * vault's folder. Sessions outlive the panel and the page; opening it again reattaches to them.
 */

const HEIGHT_KEY = 'karpathy.terminalHeight';
const FONT_SIZE = 13;
const readHeight = () => {
  try {
    const h = Number(localStorage.getItem(HEIGHT_KEY));
    return h >= 120 ? h : 0;
  } catch {
    return 0;
  }
};

/** Keys a touch keyboard lacks, for the shell and Claude Code. */
const KEYS: [string, string, string][] = [
  ['Esc', '\x1b', 'Escape'], ['Tab', '\t', 'Tab'], ['⇧Tab', '\x1b[Z', 'Shift-Tab'], ['^C', '\x03', 'Control-C'],
  ['^D', '\x04', 'Control-D'], ['↑', '\x1b[A', 'Up'], ['↓', '\x1b[B', 'Down'], ['←', '\x1b[D', 'Left'], ['→', '\x1b[C', 'Right'],
];

export function TerminalPanel() {
  const { activeId, setTerminalOpen, phone } = useApp();
  const [sessions, setSessions] = useState<TerminalInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(readHeight);
  const view = useRef<{ input: (d: string) => void; focus: () => void } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  /** The size the view will have: a shell started at another size draws its first prompt wrapped wrong. */
  const measure = useCallback(() => {
    const el = panel.current;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!el || !ctx) return { cols: 80, rows: 24 };
    ctx.font = `${FONT_SIZE}px ${cssVar('--mono') || 'monospace'}`;
    const cell = ctx.measureText('W'.repeat(20)).width / 20 || FONT_SIZE * 0.6;
    const height = el.clientHeight - 40 - (touch ? 50 : 0);
    return { cols: Math.max(20, Math.floor((el.clientWidth - 12) / cell)), rows: Math.max(5, Math.floor(height / Math.ceil(FONT_SIZE * 1.2))) };
  }, [touch]);

  const open = useCallback(async () => {
    if (!activeId) return;
    setError(null);
    try {
      const { cols, rows } = measure();
      const t = await api.openTerminal(activeId, cols, rows);
      setSessions((s) => [...(s ?? []), t]);
      setCurrent(t.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open a terminal');
    }
  }, [activeId, measure]);

  // The tab on screen stays visible in an overflowing tab strip.
  useEffect(() => {
    panel.current?.querySelector('.term-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, sessions]);

  // Reattach to the newest session of the open vault, or start one there; other vaults' sessions stay as tabs.
  useEffect(() => {
    let gone = false;
    api.terminals().then(({ terminals }) => {
      if (gone) return;
      setSessions(terminals);
      const mine = terminals.filter((t) => activeId && (t.cwd === activeId || t.cwd.startsWith(`${activeId}/`))).at(-1);
      if (mine) setCurrent(mine.id);
      else void open();
    }).catch((e) => !gone && setError(e instanceof ApiError ? e.message : 'Terminal service not reachable'));
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  const close = async (id: string) => {
    await api.closeTerminal(id).catch(() => {});
    ended(id);
  };
  const ended = (id: string) => {
    setSessions((s) => {
      const rest = (s ?? []).filter((t) => t.id !== id);
      setCurrent((c) => (c === id ? rest.at(-1)?.id ?? null : c));
      return rest;
    });
  };

  const drag = (e: ReactPointerEvent) => {
    const el = (e.currentTarget as HTMLElement).parentElement!;
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const move = (m: PointerEvent) => setHeight(Math.max(120, Math.min(innerHeight - 80, startH + startY - m.clientY)));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(el.getBoundingClientRect().height)));
      } catch { /* not kept */ }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const label = (t: TerminalInfo, i: number) => `${i + 1}: ${t.cwd.split('/').pop() || t.cwd}`;

  return (
    <section ref={panel} id="terminal" className={phone ? 'phone' : ''} aria-label="Terminal" data-testid="terminal-panel"
      style={height && !phone ? { height } : undefined}>
      {!phone && <div className="term-grip" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" onPointerDown={drag} />}
      <header className="term-bar">
        <span className="term-title">Terminal</span>
        <div className="term-tabs" role="tablist">
          {(sessions ?? []).map((t, i) => (
            <span key={t.id} className={`term-tab${t.id === current ? ' on' : ''}`} title={t.cwd}>
              <button role="tab" aria-selected={t.id === current} data-testid="terminal-tab" onClick={() => setCurrent(t.id)}>{label(t, i)}</button>
              <button className="ib" aria-label={`Close terminal ${i + 1}`} title="Close (ends the shell)" data-testid="terminal-close" onClick={() => void close(t.id)}><Icon n="xmark" size={13} /></button>
            </span>
          ))}
        </div>
        <span className="sp" />
        <button className="ib" title="New terminal" aria-label="New terminal" data-testid="terminal-new" disabled={!activeId} onClick={() => void open()}><Icon n="plus" size={18} /></button>
        <button className="ib" title="Hide (shells keep running)" aria-label="Hide terminal" data-testid="terminal-hide" onClick={() => setTerminalOpen(false)}><Icon n="chevron_down" size={18} /></button>
      </header>
      {error && <div className="term-msg" role="alert" data-testid="terminal-error">{error}</div>}
      {sessions && !sessions.length && !error && <div className="term-msg">No terminal open. <button className="link" onClick={() => void open()}>Open one</button></div>}
      {current && <XtermView key={current} id={current} onEnded={() => ended(current)} handle={view} />}
      {touch && current && (
        <div className="term-keys" data-testid="terminal-keys">
          {KEYS.map(([k, seq, name]) => (
            <button key={k} aria-label={name} onPointerDown={(e) => e.preventDefault()} onClick={() => { view.current?.input(seq); view.current?.focus(); }}>{k}</button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Reads a CSS custom property of the page (the app's light/dark palette). */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function XtermView({ id, onEnded, handle }: { id: string; onEnded: () => void; handle: React.RefObject<{ input: (d: string) => void; focus: () => void } | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(true);
  const [exit, setExit] = useState<number | null | undefined>(undefined);
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: cssVar('--mono') || 'monospace',
      fontSize: FONT_SIZE,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: cssVar('--paper') || '#fff', foreground: cssVar('--label') || '#000', cursor: cssVar('--label') || '#000', selectionBackground: 'rgba(0,122,255,.3)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(box.current!);
    const conn = new TerminalConnection(id, {
      write: (d, reset) => {
        if (reset) term.reset();
        term.write(d);
      },
      ended: (code) => {
        setExit(code ?? null);
        term.write(`\r\n\x1b[2m[${code === undefined ? 'session ended' : `exited with ${code}`}]\x1b[0m\r\n`);
        // Leave the last screen readable for a moment, then drop the tab.
        setTimeout(() => endedRef.current(), 1500);
      },
      status: setLive,
    });
    const refit = () => {
      if (!box.current?.offsetHeight) return;
      fit.fit();
      conn.resize(term.cols, term.rows);
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(box.current!);
    const sub = term.onData((d) => conn.input(d));
    handle.current = { input: (d) => conn.input(d), focus: () => term.focus() };
    term.focus();
    return () => {
      ro.disconnect();
      sub.dispose();
      conn.detach();
      term.dispose();
      handle.current = null;
    };
  }, [id, handle]);

  return (
    <div className="term-view">
      <div className="term-xterm" ref={box} data-testid="terminal-xterm" data-live={live} data-exit={exit === undefined ? undefined : String(exit)} />
      {!live && exit === undefined && <div className="term-reconnect" role="status">Reconnecting…</div>}
    </div>
  );
}
