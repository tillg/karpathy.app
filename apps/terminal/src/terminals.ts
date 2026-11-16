import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { spawn, type IPty } from 'node-pty';

/**
 * Shell sessions on pseudo-terminals (#175). A session outlives its stream: it ends when it is closed or its shell
 * exits, so a dropped connection (an iPad in the background) loses nothing. Any number of streams attach at once (the
 * Mac and the iPhone): each gets all output, and any client can type. The pseudo-terminal has one size, the last one a
 * client set; every stream hears of it (`size`). Output is numbered by its end offset (`at`), so a reattach can resume where its page left off, or
 * replay the scrollback when it can't.
 */

/** A chunk of output (`at` = offset after it; `reset`: the first chunk of a replay that doesn't continue the page). */
export type StreamEvent = { t: 'o'; d: string; at: number; reset?: boolean } | { t: 'x'; code: number } | { t: 'size'; cols: number; rows: number };

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
  sinks: Set<Sink>;
  /** Streams that reported backpressure, with the timer that drops them if they stay blocked. */
  blocked: Map<Sink, ReturnType<typeof setTimeout>>;
  paused: boolean;
  /** The shell's terminal (macOS only): every process it starts keeps it, also after the shell exits. */
  tty: string | null;
  /** macOS: the processes seen on its tty. Once the shell exits the tty is revoked and they can't be found by it. */
  known: Set<number>;
  watch?: ReturnType<typeof setInterval>;
  /** Per page (`cid`): the last input sequence numbers taken, so a retried chunk isn't typed twice. */
  seen: Map<string, number[]>;
}

/** Tags a page's input chunk; a retry sends the same tag. */
export interface InputTag {
  cid: string;
  seq: number;
}

export interface TerminalsOptions {
  shell: string;
  /** The shell's environment on top of TERM, LANG and PATH; nothing else of the server's env leaks in. */
  env?: Record<string, string>;
  max?: number;
  scrollback?: number;
  /** How long a blocked stream may hold the shell before it is dropped (it reconnects and resumes). */
  stallMs?: number;
}

export class Terminals {
  private sessions = new Map<string, Session>();
  private max: number;
  private scrollback: number;
  private stallMs: number;

  constructor(private opts: TerminalsOptions) {
    this.max = opts.max ?? 4;
    this.scrollback = opts.scrollback ?? 256 * 1024;
    this.stallMs = opts.stallMs ?? 5000;
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
    const s: Session = { id: randomUUID(), cwd: label, cols, rows, created: new Date().toISOString(), pty, buffer: '', total: 0, sinks: new Set(), blocked: new Map(), paused: false, tty: ttyOf(pty), known: new Set(), seen: new Map() };
    pty.onData((d) => {
      s.total += d.length;
      s.buffer = (s.buffer + d).slice(-this.scrollback);
      this.broadcast(s, { t: 'o', d, at: s.total });
    });
    pty.onExit(({ exitCode }) => {
      if (!this.sessions.has(s.id)) return;
      this.sessions.delete(s.id);
      // Its background jobs are orphans now, still in its session.
      this.reap(s);
      for (const k of s.sinks) {
        k.send({ t: 'x', code: exitCode });
        this.drop(s, k);
      }
    });
    if (s.tty) {
      s.watch = setInterval(() => this.track(s), 1000);
      s.watch.unref();
    }
    this.sessions.set(s.id, s);
    return this.list().find((t) => t.id === s.id)!;
  }

  /**
   * Attaches a stream; returns its detach. `from`: the offset the page has seen; output after it is sent if the
   * scrollback still holds it, else the whole scrollback with `reset`.
   */
  attach(id: string, from: number | undefined, sink: Sink): () => void {
    const s = this.get(id);
    s.sinks.add(sink);
    const start = s.total - s.buffer.length;
    const resume = from !== undefined && from >= start && from <= s.total;
    const replay = resume ? s.buffer.slice(from - start) : s.buffer;
    sink.onDrain(() => {
      clearTimeout(s.blocked.get(sink));
      s.blocked.delete(sink);
      if (!s.blocked.size) this.resume(s);
    });
    if (replay || !resume) this.deliver(s, sink, { t: 'o', d: replay, at: s.total, reset: !resume });
    this.deliver(s, sink, { t: 'size', cols: s.cols, rows: s.rows });
    return () => {
      if (!s.sinks.has(sink)) return;
      s.sinks.delete(sink);
      clearTimeout(s.blocked.get(sink));
      s.blocked.delete(sink);
      // Detached output only fills the scrollback: never leave the shell blocked.
      if (!s.blocked.size) this.resume(s);
    };
  }

  /** How many streams are attached. */
  attached(id: string) {
    return this.get(id).sinks.size;
  }

  input(id: string, data: string, tag?: InputTag) {
    const s = this.get(id);
    if (tag) {
      const seqs = s.seen.get(tag.cid) ?? [];
      // A request that reached the shell but whose answer got lost comes again: take it once.
      if (seqs.includes(tag.seq)) return;
      s.seen.delete(tag.cid);
      s.seen.set(tag.cid, [...seqs, tag.seq].slice(-64));
      if (s.seen.size > 16) s.seen.delete(s.seen.keys().next().value!);
    }
    // A line may start a job and the next one end the shell: note what runs on its tty while it still can be found.
    if (/[\r\n]/.test(data)) this.track(s);
    s.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.get(id);
    s.cols = cols;
    s.rows = rows;
    s.pty.resize(cols, rows);
    this.broadcast(s, { t: 'size', cols, rows });
  }

  isPaused(id: string) {
    return this.get(id).paused;
  }

  /**
   * Ends the session: the shell and everything it started. Job control gives background jobs process groups of their
   * own and a subshell that exits orphans its jobs, so the whole session is killed, not the shell's group or tree.
   */
  close(id: string) {
    const s = this.get(id);
    this.sessions.delete(id);
    this.reap(s);
    for (const k of s.sinks) this.drop(s, k);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new TerminalNotFound(id);
    return s;
  }

  /** Kills the shell and everything in its session (jobs in their own process groups, orphans of an exited shell). */
  private reap(s: Session) {
    clearInterval(s.watch);
    this.track(s);
    for (const pid of [s.pty.pid, ...sessionMembers(s.pty.pid, s.tty), ...s.known]) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
  }

  /** macOS only (see `known`). Forgets the ones that ended, so their pids are never killed after the system reuses them. */
  private track(s: Session) {
    if (!s.tty) return;
    for (const pid of s.known) {
      try {
        process.kill(pid, 0);
      } catch {
        s.known.delete(pid);
      }
    }
    for (const pid of sessionMembers(s.pty.pid, s.tty)) s.known.add(pid);
  }

  private broadcast(s: Session, e: StreamEvent) {
    for (const k of s.sinks) this.deliver(s, k, e);
  }

  /** Sends to one stream; on backpressure the shell pauses, and a stream still blocked after `stallMs` is dropped. */
  private deliver(s: Session, k: Sink, e: StreamEvent) {
    if (k.send(e) || s.blocked.has(k)) return;
    this.pause(s);
    s.blocked.set(k, setTimeout(() => {
      this.drop(s, k);
      if (!s.blocked.size) this.resume(s);
    }, this.stallMs));
  }

  private drop(s: Session, k: Sink) {
    clearTimeout(s.blocked.get(k));
    s.blocked.delete(k);
    s.sinks.delete(k);
    k.end();
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

/**
 * macOS has no /proc and its ps can't name a session (`sess` is 0 for every process: matching on it
 * kills them all). The session's controlling terminal stands in for it: `ttys012` for `/dev/ttys012`.
 */
function ttyOf(pty: IPty): string | null {
  const name = (pty as IPty & { ptsName?: string }).ptsName ?? '';
  return /^\/dev\/(ttys\d+)$/.exec(name)?.[1] ?? null;
}

/** The processes in the session the shell `sid` leads (Linux: /proc's session field; macOS: its tty). */
function sessionMembers(sid: number, tty: string | null): number[] {
  if (process.platform === 'linux') {
    const out: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        // pid (comm) state ppid pgrp session …; comm may hold spaces and parentheses.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[3]) === sid) out.push(Number(name));
      } catch { /* gone meanwhile */ }
    }
    return out;
  }
  if (!tty) return [];
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,tty='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter(([pid, x]) => pid && x === tty)
      .map(([pid]) => Number(pid));
  } catch {
    return [];
  }
}
