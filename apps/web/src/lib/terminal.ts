import type { TerminalEvent } from '@karpathy/shared';
import { api, ApiError, request } from './api';
import { readNdjson } from './ndjson';

/**
 * One terminal session's link to the server (#175): reads its output stream and reconnects when it drops (an iPad in
 * the background), resuming from the last offset it saw; sends keystrokes in order, one request at a time, again after a failure; debounces
 * resizes. The session itself lives on the server until it is closed or its shell exits. Other devices may be attached
 * too, all getting the same output; the shell has one size, the one of the client last typed in or focused (`claim`).
 */
export interface TerminalSink {
  /** Output; `reset`: the page doesn't continue, clear the screen first. */
  write(data: string, reset: boolean): void;
  /** The shell exited (code) or the session is gone (undefined). */
  ended(code?: number): void;
  /** The stream is up, or waiting to reconnect. */
  status(live: boolean): void;
}

const RETRY_MS = 1000;
const INPUT_RETRY_MS = 500;

export class TerminalConnection {
  private at: number | undefined;
  private ctrl = new AbortController();
  private closed = false;
  private pending = '';
  private sending = false;
  /** This page's input tag: the service takes each (cid, seq) once, so a retry is never typed twice. */
  private cid = crypto.randomUUID();
  private seq = 0;
  /** A chunk whose request failed: sent again as it was (same seq), never merged with later keys. */
  private retry: { data: string; seq: number } | undefined;
  private size: { cols: number; rows: number } | null = null;
  /** The shell's size, as the server last announced it (another device may have set it). */
  private shellSize: { cols: number; rows: number } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly id: string, private sink: TerminalSink) {
    void this.loop();
    addEventListener('pagehide', this.onHide);
  }

  /** The page goes (reload, closed tab): what's still queued goes out now, as a keepalive request. */
  private onHide = () => {
    if (this.closed) return;
    const chunks = [this.retry, this.pending ? { data: this.pending, seq: ++this.seq } : undefined];
    this.retry = undefined;
    this.pending = '';
    for (const c of chunks) if (c) void api.terminalInput(this.id, c.data, { cid: this.cid, seq: c.seq }).catch(() => {});
  };

  private async loop() {
    while (!this.closed) {
      try {
        const res = await request('GET', `/terminals/${this.id}/stream${this.at === undefined ? '' : `?from=${this.at}`}`, undefined, this.ctrl.signal);
        this.sink.status(true);
        await readNdjson<TerminalEvent>(res, (e) => {
          if (e.t === 'size') {
            this.shellSize = { cols: e.cols, rows: e.rows };
            return;
          }
          if (e.t === 'x') {
            this.finish(e.code);
            return;
          }
          // A replay to a page that saw output before: the screen is redrawn from scratch.
          const reset = Boolean(e.reset) && this.at !== undefined;
          this.at = e.at;
          if (e.d || reset) this.sink.write(e.d, reset);
          // A full-screen program (vi, top, Claude Code) repaints on a size change, not on a replay.
          if (e.reset && this.size) this.nudge();
        });
      } catch (err) {
        if (this.closed) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return this.finish();
      }
      if (this.closed) return;
      this.sink.status(false);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }

  private finish(code?: number) {
    if (this.closed) return;
    this.closed = true;
    this.ctrl.abort();
    this.sink.ended(code);
  }

  /** Keystrokes, in order: what arrives while a request is out goes in the next one. */
  input(data: string) {
    if (this.closed) return;
    this.claim();
    this.pending += data;
    if (!this.sending) void this.flush();
  }

  private async flush() {
    this.sending = true;
    while ((this.retry || this.pending) && !this.closed) {
      const chunk = this.retry ?? { data: this.pending, seq: ++this.seq };
      if (!this.retry) this.pending = '';
      this.retry = undefined;
      try {
        await api.terminalInput(this.id, chunk.data, { cid: this.cid, seq: chunk.seq });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          this.finish();
          break;
        }
        // Refused (too long, bad request): sending it again can't help, and later keys must not wait behind it.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) continue;
        // Not lost: sent again shortly, as it was; the service drops it if the first request did arrive.
        this.retry = chunk;
        await new Promise((r) => setTimeout(r, INPUT_RETRY_MS));
      }
    }
    this.sending = false;
  }

  resize(cols: number, rows: number) {
    if (this.size?.cols === cols && this.size.rows === rows) return;
    this.size = { cols, rows };
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => void api.terminalResize(this.id, cols, rows).catch(() => {}), 100);
  }

  /** This client is the one in use (typing, focus): the shell takes its size again if another device changed it. */
  claim() {
    const s = this.size;
    if (this.closed || !s || !this.shellSize || (this.shellSize.cols === s.cols && this.shellSize.rows === s.rows)) return;
    this.shellSize = s;
    clearTimeout(this.resizeTimer);
    void api.terminalResize(this.id, s.cols, s.rows).catch(() => {});
  }

  private nudge() {
    const { cols, rows } = this.size!;
    void api.terminalResize(this.id, cols, Math.max(1, rows - 1))
      .then(() => api.terminalResize(this.id, cols, rows))
      .catch(() => {});
  }

  /** Stops reading (the session stays on the server). */
  detach() {
    removeEventListener('pagehide', this.onHide);
    this.closed = true;
    clearTimeout(this.resizeTimer);
    this.ctrl.abort();
  }
}
