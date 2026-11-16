import type { TerminalEvent } from '@karpathy/shared';
import { api, ApiError, request } from './api';
import { readNdjson } from './ndjson';

/**
 * One terminal session's link to the server (#175): reads its output stream and reconnects when it drops (an iPad in
 * the background), resuming from the last offset it saw; sends keystrokes in order, one request at a time, again after a failure; debounces
 * resizes. The session itself lives on the server until it is closed or its shell exits.
 */
export interface TerminalSink {
  /** Output; `reset`: the page doesn't continue, clear the screen first. */
  write(data: string, reset: boolean): void;
  /** The shell exited (code) or the session is gone (undefined). */
  ended(code?: number): void;
  /** The stream is up, or waiting to reconnect. */
  status(live: boolean): void;
  /** Another device or tab attached to the session and took it over; this connection stops (no reconnect). */
  taken(): void;
}

const RETRY_MS = 1000;
const INPUT_RETRY_MS = 500;

export class TerminalConnection {
  private at: number | undefined;
  private ctrl = new AbortController();
  private closed = false;
  private pending = '';
  private sending = false;
  private size: { cols: number; rows: number } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly id: string, private sink: TerminalSink) {
    void this.loop();
    addEventListener('pagehide', this.onHide);
  }

  /** The page goes (reload, closed tab): what's still queued goes out now, as a keepalive request. */
  private onHide = () => {
    if (!this.pending || this.closed) return;
    const data = this.pending;
    this.pending = '';
    void api.terminalInput(this.id, data).catch(() => {});
  };

  private async loop() {
    while (!this.closed) {
      try {
        const res = await request('GET', `/terminals/${this.id}/stream${this.at === undefined ? '' : `?from=${this.at}`}`, undefined, this.ctrl.signal);
        this.sink.status(true);
        await readNdjson<TerminalEvent>(res, (e) => {
          if (e.t === 'taken') {
            this.closed = true;
            this.ctrl.abort();
            this.sink.taken();
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
    this.pending += data;
    if (!this.sending) void this.flush();
  }

  private async flush() {
    this.sending = true;
    while (this.pending && !this.closed) {
      const data = this.pending;
      this.pending = '';
      try {
        await api.terminalInput(this.id, data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          this.finish();
          break;
        }
        // Not lost: back in front of what was typed meanwhile, sent again shortly.
        this.pending = data + this.pending;
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
