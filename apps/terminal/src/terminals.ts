import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';

/**
 * Shell sessions on pseudo-terminals (#175). A session outlives its stream: it ends when it is closed or its shell
 * exits, so a dropped connection (an iPad in the background) loses nothing. One stream at a time is attached; a new
 * one takes over. Output is numbered by its end offset (`at`), so a reattach can resume where its page left off, or
 * replay the scrollback when it can't.
 */

/** A chunk of output (`at` = offset after it; `reset`: the first chunk of a replay that doesn't continue the page). */
export type StreamEvent = { t: 'o'; d: string; at: number; reset?: boolean } | { t: 'x'; code: number };

/** Where a session's output goes: an NDJSON response, in the server. `send` returns false on backpressure. */
export interface Sink {
  send(e: StreamEvent): boolean;
  onDrain(fn: () => void): void;
  end(): void;
}

export interface TerminalInfo {
  id: string;
  /** The folder it started in, as given to `open`. */
  cwd: string;
  cols: number;
  rows: number;
  created: string;
}

export class TerminalLimitError extends Error {}

interface Session extends TerminalInfo {
  pty: IPty;
  /** Recent output, at most `scrollback` characters, ending at offset `total`. */
  buffer: string;
  total: number;
  sink?: Sink;
  paused: boolean;
}

export interface TerminalsOptions {
  shell: string;
  /** The shell's environment on top of TERM, LANG and PATH; nothing else of the server's env leaks in. */
  env?: Record<string, string>;
  max?: number;
  scrollback?: number;
}

export class Terminals {
  private sessions = new Map<string, Session>();
  private max: number;
  private scrollback: number;

  constructor(private opts: TerminalsOptions) {
    this.max = opts.max ?? 4;
    this.scrollback = opts.scrollback ?? 256 * 1024;
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map(({ id, cwd, cols, rows, created }) => ({ id, cwd, cols, rows, created }));
  }

  has(id: string) {
    return this.sessions.has(id);
  }

  open(cwd: string, cols: number, rows: number, label = cwd): TerminalInfo {
    if (this.sessions.size >= this.max)
      throw new TerminalLimitError(`at most ${this.max} terminals at a time: close one first`);
    const pty = spawn(this.opts.shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...this.opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const s: Session = { id: randomUUID(), cwd: label, cols, rows, created: new Date().toISOString(), pty, buffer: '', total: 0, paused: false };
    pty.onData((d) => {
      s.total += d.length;
      s.buffer = (s.buffer + d).slice(-this.scrollback);
      if (s.sink && !s.sink.send({ t: 'o', d, at: s.total })) this.pause(s);
    });
    pty.onExit(({ exitCode }) => {
      if (!this.sessions.has(s.id)) return;
      this.sessions.delete(s.id);
      s.sink?.send({ t: 'x', code: exitCode });
      s.sink?.end();
    });
    this.sessions.set(s.id, s);
    return this.list().find((t) => t.id === s.id)!;
  }

  /**
   * Attaches a stream; returns its detach. `from`: the offset the page has seen; output after it is sent if the
   * scrollback still holds it, else the whole scrollback with `reset`.
   */
  attach(id: string, from: number | undefined, sink: Sink): () => void {
    const s = this.get(id);
    if (s.sink) s.sink.end();
    s.sink = sink;
    const start = s.total - s.buffer.length;
    const resume = from !== undefined && from >= start && from <= s.total;
    const replay = resume ? s.buffer.slice(from - start) : s.buffer;
    sink.onDrain(() => this.resume(s));
    this.resume(s);
    if ((replay || !resume) && !sink.send({ t: 'o', d: replay, at: s.total, reset: !resume })) this.pause(s);
    return () => {
      if (s.sink !== sink) return;
      s.sink = undefined;
      // Detached output only fills the scrollback: never leave the shell blocked.
      this.resume(s);
    };
  }

  input(id: string, data: string) {
    this.get(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.get(id);
    s.cols = cols;
    s.rows = rows;
    s.pty.resize(cols, rows);
  }

  isPaused(id: string) {
    return this.get(id).paused;
  }

  /**
   * Ends the session: the shell and everything it started. Job control gives background jobs process groups of their
   * own, so the whole tree of descendants is killed, not just the shell's group.
   */
  close(id: string) {
    const s = this.get(id);
    this.sessions.delete(id);
    for (const pid of [...descendants(s.pty.pid), s.pty.pid]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    s.sink?.end();
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalNotFound(id);
    return s;
  }

  private pause(s: Session) {
    if (s.paused) return;
    s.paused = true;
    s.pty.pause();
  }

  private resume(s: Session) {
    if (!s.paused) return;
    s.paused = false;
    s.pty.resume();
  }
}

export class TerminalNotFound extends Error {
  constructor(id: string) {
    super(`no terminal ${id}`);
  }
}

/** Every process below `root` (busybox and macOS `ps` both take `-A -o pid=,ppid=`). */
function descendants(root: number): number[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const stack = [root];
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) { found.push(c); stack.push(c); }
  return found;
}
