import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalLimitError, Terminals, type Sink, type StreamEvent } from '../src/terminals.js';

/** A sink that collects what a session sends; `slow` makes every write report backpressure. */
function collector(slow = false) {
  const events: StreamEvent[] = [];
  let drain = () => {};
  const sink: Sink = {
    send: (e) => { events.push(e); return !slow; },
    onDrain: (fn) => { drain = fn; },
    end: () => events.push({ t: 'end' } as unknown as StreamEvent),
  };
  const text = () => events.filter((e) => e.t === 'o').map((e) => (e as { d: string }).d).join('');
  return { sink, events, text, drain: () => drain() };
}

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let terms: Terminals;
afterEach(() => terms?.closeAll());

describe('Terminals', () => {
  it('runs a shell in the given folder and streams its output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'term-'));
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(cwd, 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'pwd; echo "sum=$((40+2))"\r');
    await until(() => c.text().includes('sum=42'));
    expect(c.text()).toContain(cwd.split('/').pop());
  });

  it('resizes the pseudo-terminal', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.resize(t.id, 101, 33);
    terms.input(t.id, 'stty size\r');
    await until(() => c.text().includes('33 101'));
  });

  it('closing a session kills its whole process group', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'sleep 300 & echo bg=$!\r');
    await until(() => /bg=(\d+)/.test(c.text()));
    const pid = Number(/bg=(\d+)/.exec(c.text())![1]);
    expect(alive(pid)).toBe(true);
    terms.close(t.id);
    await until(() => !alive(pid));
    expect(terms.list()).toEqual([]);
  });

  it('a shell that exits by itself takes its background jobs with it', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'sleep 300 & echo bg=$!\r');
    await until(() => /bg=(\d+)/.test(c.text()));
    const pid = Number(/bg=(\d+)/.exec(c.text())![1]);
    expect(alive(pid)).toBe(true);
    terms.input(t.id, 'exit\r');
    await until(() => c.events.some((e) => e.t === 'x'));
    await until(() => !alive(pid));
  });

  it('closing a session also kills a job whose parent exited at once (no process tree leads to it)', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, '( sleep 300 & echo bg=$! )\r');
    await until(() => /bg=(\d+)/.test(c.text()));
    const pid = Number(/bg=(\d+)/.exec(c.text())![1]);
    expect(alive(pid)).toBe(true);
    terms.close(t.id);
    await until(() => !alive(pid));
  });

  it('closing or exiting a session leaves processes outside it alone', async () => {
    const outsider = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      terms = new Terminals({ shell: '/bin/sh' });
      const a = terms.open(tmpdir(), 80, 24);
      const b = terms.open(tmpdir(), 80, 24);
      const c = collector();
      terms.attach(b.id, undefined, c.sink);
      terms.input(b.id, 'exit\r');
      await until(() => c.events.some((e) => e.t === 'x'));
      terms.close(a.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(outsider.pid!)).toBe(true);
    } finally {
      outsider.kill('SIGKILL');
    }
  });

  it('a retried input chunk (same page and sequence number) is typed once', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'echo "r$((1+1))"\r', { cid: 'page-a', seq: 1 });
    terms.input(t.id, 'echo "r$((1+1))"\r', { cid: 'page-a', seq: 1 });
    // Another page's chunk 1 is its own.
    terms.input(t.id, 'echo "D$((0))NE"\r', { cid: 'page-b', seq: 1 });
    await until(() => c.text().includes('D0NE\r\n'));
    expect(c.text().match(/r2\r\n/g)).toHaveLength(1);
  });

  it('a second stream takes the session; the first is told, then ended', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const first = collector();
    const second = collector();
    terms.attach(t.id, undefined, first.sink);
    terms.attach(t.id, undefined, second.sink);
    expect(first.events.slice(-2)).toEqual([{ t: 'taken' }, { t: 'end' }]);
    expect(terms.attached(t.id)).toBe(true);
  });

  it('an exiting shell ends the session and tells the stream', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'exit 3\r');
    await until(() => c.events.some((e) => e.t === 'x'));
    expect(c.events.find((e) => e.t === 'x')).toMatchObject({ t: 'x', code: 3 });
    expect(terms.list()).toEqual([]);
  });

  it('a session outlives its stream; a reattach resumes from an offset or replays the scrollback', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const a = collector();
    const detach = terms.attach(t.id, undefined, a.sink);
    terms.input(t.id, 'echo "o$((0))ne"\r');
    await until(() => a.text().includes('o0ne\r\n'));
    const seen = (a.events.filter((e) => e.t === 'o').at(-1) as { at: number }).at;
    detach();
    terms.input(t.id, 'echo "t$((0))wo"\r');
    await new Promise((r) => setTimeout(r, 300));
    expect(terms.list().map((x) => x.id)).toEqual([t.id]);

    const b = collector();
    terms.attach(t.id, seen, b.sink);
    await until(() => b.text().includes('t0wo\r\n'));
    expect(b.text()).not.toContain('o0ne');
    expect(b.events[0]).toMatchObject({ t: 'o', reset: false });

    const fresh = collector();
    terms.attach(t.id, undefined, fresh.sink);
    await until(() => fresh.text().includes('t0wo\r\n'));
    expect(fresh.text()).toContain('o0ne\r\n');
    expect(fresh.events[0]).toMatchObject({ t: 'o', reset: true });
    // The earlier stream was taken over.
    expect(b.events.at(-1)).toMatchObject({ t: 'end' });
  });

  it('keeps only the last bytes of scrollback', async () => {
    terms = new Terminals({ shell: '/bin/sh', scrollback: 1000 });
    const t = terms.open(tmpdir(), 80, 24);
    terms.input(t.id, 'i=0; while [ $i -lt 300 ]; do echo "line $i"; i=$((i+1)); done; echo "D$((0))NE"\r');
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    await until(() => c.text().includes('D0NE\r\n'));
    const fresh = collector();
    terms.attach(t.id, undefined, fresh.sink);
    expect(fresh.text().length).toBeLessThanOrEqual(1000);
    expect(fresh.text()).toContain('line 299');
  });

  it('refuses more than the maximum number of sessions', () => {
    terms = new Terminals({ shell: '/bin/sh', max: 2 });
    terms.open(tmpdir(), 80, 24);
    terms.open(tmpdir(), 80, 24);
    expect(() => terms.open(tmpdir(), 80, 24)).toThrow(TerminalLimitError);
  });

  it('pauses the shell while the stream reports backpressure and resumes on drain', async () => {
    terms = new Terminals({ shell: '/bin/sh' });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector(true);
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'echo first\r');
    await until(() => c.events.length > 0);
    expect(terms.isPaused(t.id)).toBe(true);
    c.drain();
    expect(terms.isPaused(t.id)).toBe(false);
  });

  it('gives the shell a clean environment: no inherited secrets, a UTF-8 locale and a 256-colour TERM', async () => {
    process.env.SOME_SECRET = 'leak-me';
    terms = new Terminals({ shell: '/bin/sh', env: { HOME: tmpdir() } });
    const t = terms.open(tmpdir(), 80, 24);
    const c = collector();
    terms.attach(t.id, undefined, c.sink);
    terms.input(t.id, 'echo "$((1+1))s=[$SOME_SECRET] t=$TERM l=$LANG"\r');
    await until(() => /2s=\[[^\]]*\] t=\S+ l=\S+\r\n/.test(c.text()));
    expect(c.text()).toContain('2s=[] t=xterm-256color l=C.UTF-8');
    delete process.env.SOME_SECRET;
  });
});
