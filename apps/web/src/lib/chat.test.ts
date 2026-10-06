import { describe, expect, it } from 'vitest';
import type { ChatEvent, ChatMessage, ToolCall } from '@karpathy/shared';
import { adoptQueued, applyChatEvent, changedPaths, newOpens, noteToOpen, opensFromEvent, opensFromLoad, settlePending, toolHref, toolLabel, turnAnnouncement, turns, type ChatView, type PendingPrompt } from './chat';

const empty: ChatView = { id: 'c1', title: 'T', messages: [], turn: 'idle' };

describe('applyChatEvent', () => {
  it('tracks turn state and read-only flag', () => {
    const c = applyChatEvent(empty, { type: 'turn', state: 'queued', readonly: true });
    expect(c.turn).toBe('queued');
    expect(c.readonly).toBe(true);
    expect(applyChatEvent(c, { type: 'turn', state: 'running' }).readonly).toBe(true);
  });

  it('adds messages, upserts parts by id and appends text deltas', () => {
    let c = applyChatEvent(empty, { type: 'message', message: { id: 'm1', role: 'assistant', createdAt: 1 } });
    c = applyChatEvent(c, { type: 'part', messageId: 'm1', part: { type: 'text', id: 'p1', text: 'Hel' } });
    c = applyChatEvent(c, { type: 'text-delta', messageId: 'm1', partId: 'p1', delta: 'lo' });
    c = applyChatEvent(c, { type: 'part', messageId: 'm1', part: { type: 'tool', id: 't1', call: { id: 't1', tool: 'read', status: 'running', path: 'a.md', writes: false } } });
    c = applyChatEvent(c, { type: 'part', messageId: 'm1', part: { type: 'tool', id: 't1', call: { id: 't1', tool: 'read', status: 'completed', path: 'a.md', writes: false } } });
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.parts).toEqual([
      { type: 'text', id: 'p1', text: 'Hello' },
      { type: 'tool', id: 't1', call: { id: 't1', tool: 'read', status: 'completed', path: 'a.md', writes: false } },
    ]);
  });

  it('creates a placeholder message for a delta that arrives first', () => {
    const c = applyChatEvent(empty, { type: 'text-delta', messageId: 'm9', partId: 'p', delta: 'x' });
    expect(c.messages[0]).toMatchObject({ id: 'm9', role: 'assistant', parts: [{ type: 'text', id: 'p', text: 'x' }] });
  });
});

describe('changedPaths', () => {
  it('lists completed write paths once', () => {
    const call = (id: string, path: string, writes: boolean, status: 'completed' | 'denied' = 'completed') =>
      ({ type: 'tool' as const, id, call: { id, tool: writes ? 'edit' : 'read', status, path, writes } });
    expect(changedPaths([call('1', 'a.md', true), call('2', 'b.md', false), call('3', 'a.md', true), call('4', 'c.md', true, 'denied')])).toEqual(['a.md']);
  });

  it('changedPaths excludes opened notes', () => {
    expect(changedPaths([{ type: 'tool', id: 'o', call: { id: 'o', tool: 'open_note', status: 'completed', path: 'a.md', writes: false, opens: true } }])).toEqual([]);
  });
});

describe('noteToOpen', () => {
  const ev = (id: string, call: Partial<ToolCall> = {}): ChatEvent =>
    ({ type: 'part', messageId: 'm', part: { type: 'tool', id, call: { id, tool: 'open_note', status: 'completed', path: 'notes/a.md', writes: false, opens: true, ...call } } });

  it('returns the path of a live, completed open call once', () => {
    const seen = new Set<string>();
    expect(noteToOpen(ev('o1'), seen)).toBe('notes/a.md');
    expect(noteToOpen(ev('o1'), seen)).toBeNull();
  });

  it('ignores running, error, read and write calls, and other events', () => {
    const seen = new Set<string>();
    expect(noteToOpen(ev('o1', { status: 'running' }), seen)).toBeNull();
    expect(noteToOpen(ev('o2', { status: 'error' }), seen)).toBeNull();
    expect(noteToOpen(ev('r', { tool: 'read', opens: false }), seen)).toBeNull();
    expect(noteToOpen(ev('w', { tool: 'edit', opens: false, writes: true }), seen)).toBeNull();
    expect(noteToOpen({ type: 'turn', state: 'idle' }, seen)).toBeNull();
    // A running part doesn't use up its id: the completed one still opens.
    expect(noteToOpen(ev('o1'), seen)).toBe('notes/a.md');
  });

});

describe('opens tracker', () => {
  const part = (id: string, call: Partial<ToolCall> = {}) => (ev(id, call) as Extract<ChatEvent, { type: 'part' }>).part;
  const ev = (id: string, call: Partial<ToolCall> = {}): ChatEvent =>
    ({ type: 'part', messageId: 'm', part: { type: 'tool', id, call: { id, tool: 'open_note', status: 'completed', path: `notes/${id}.md`, writes: false, opens: true, ...call } } });
  const history = (...parts: ReturnType<typeof part>[]): ChatMessage[] => [{ id: 'm', role: 'assistant', createdAt: 1, parts }];
  const idle: ChatEvent = { type: 'turn', state: 'idle' };

  it('the first load never opens history, but a call still running then opens when it completes', () => {
    const o = newOpens();
    expect(opensFromLoad(o, history(part('o1'), part('o2', { status: 'running' })), 'running', false)).toBeNull();
    expect(opensFromEvent(o, ev('o1'), false)).toBeNull();
    expect(opensFromEvent(o, ev('o2'), false)).toBe('notes/o2.md');
  });

  it('a reload after a dropped stream picks up opens that completed in the gap, once', () => {
    const o = newOpens();
    opensFromLoad(o, history(part('o1')), 'running', false);
    expect(opensFromLoad(o, history(part('o1'), part('o2'), part('o3')), 'running', false)).toBe('notes/o3.md');
    expect(opensFromLoad(o, history(part('o1'), part('o2'), part('o3')), 'idle', false)).toBeNull();
    expect(opensFromEvent(o, ev('o3'), false)).toBeNull();
  });

  it('deferred (layouts that are not wide): the last open of the turn shows when the turn ends', () => {
    const o = newOpens();
    opensFromLoad(o, [], 'running', true);
    expect(opensFromEvent(o, ev('o1'), true)).toBeNull();
    expect(opensFromEvent(o, ev('o2'), true)).toBeNull();
    expect(opensFromEvent(o, idle, true)).toBe('notes/o2.md');
    expect(opensFromEvent(o, idle, true)).toBeNull();
  });

  it('deferred: a turn that ended while the stream was down shows its open on the reload', () => {
    const o = newOpens();
    opensFromLoad(o, [], 'running', true);
    expect(opensFromEvent(o, ev('o1'), true)).toBeNull();
    expect(opensFromLoad(o, history(part('o1'), part('o2')), 'idle', true)).toBe('notes/o2.md');
  });
});

describe('settlePending', () => {
  const p: PendingPrompt = { text: 'hi', userCount: 0, sent: true, ran: false };
  const user = { id: 'u1', role: 'user' as const, createdAt: 1, parts: [{ type: 'text' as const, id: 'x', text: 'hi' }] };

  it('keeps the bubble while the prompt is queued or not yet accepted', () => {
    expect(settlePending(p, { ...empty, turn: 'queued' })).toBe(p);
    const unsent = { ...p, sent: false };
    expect(settlePending(unsent, empty)).toBe(unsent);
  });

  it('drops it once the server has the user message', () => {
    expect(settlePending(p, { ...empty, turn: 'running', messages: [user] })).toBe('drop');
  });

  it('restores the text when the turn goes idle without having run (stopped while queued)', () => {
    expect(settlePending(p, empty)).toBe('restore');
  });

  it('does not restore after the turn ran', () => {
    const ran = settlePending(p, { ...empty, turn: 'running' });
    expect(ran).toEqual({ ...p, ran: true });
    expect(settlePending(ran as PendingPrompt, empty)).toBe('drop');
  });
});

describe('adoptQueued (#13: queued prompt after reload / from another device)', () => {
  it('shows the server-side queued prompt when there is no local one', () => {
    const p = adoptQueued(null, { ...empty, turn: 'queued', queuedText: 'hello' });
    expect(p).toEqual({ text: 'hello', userCount: 0, sent: true, ran: false });
    // Stopped while queued → back into the composer.
    expect(settlePending(p!, empty)).toBe('restore');
  });
  it('keeps a local pending prompt and ignores idle/running chats', () => {
    const local: PendingPrompt = { text: 'mine', userCount: 0, sent: false, ran: false };
    expect(adoptQueued(local, { ...empty, turn: 'queued', queuedText: 'x' })).toBe(local);
    expect(adoptQueued(null, { ...empty, turn: 'queued' })).toBeNull();
    expect(adoptQueued(null, { ...empty, turn: 'running', queuedText: 'x' })).toBeNull();
  });
});

describe('turnAnnouncement (issue #45)', () => {
  const reply = (text: string, error?: string): ChatView => ({
    ...empty,
    messages: [
      { id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', id: 'p0', text: 'q' }] },
      { id: 'a', role: 'assistant', createdAt: 2, error, parts: [{ type: 'reasoning', id: 'r', text: 'hmm' }, { type: 'text', id: 'p1', text }] },
    ],
  });

  it('says nothing on the first load or without a state change (no deltas)', () => {
    expect(turnAnnouncement(undefined, { ...empty, turn: 'running' })).toBeNull();
    expect(turnAnnouncement('running', { ...reply('partial'), turn: 'running' })).toBeNull();
    expect(turnAnnouncement('idle', reply('old'))).toBeNull();
  });

  it('announces the start and the finished reply text (not the reasoning)', () => {
    expect(turnAnnouncement('queued', { ...empty, turn: 'running' })).toBe('AI is replying…');
    expect(turnAnnouncement('running', reply('It says hello.'))).toBe('Reply finished: It says hello.');
    expect(turnAnnouncement('running', reply('x'.repeat(500)))).toBe(`Reply finished: ${'x'.repeat(300)}…`);
    expect(turnAnnouncement('running', reply(''))).toBe('Reply finished');
  });

  it('announces waiting and failures', () => {
    expect(turnAnnouncement('idle', { ...empty, turn: 'queued', waiting: 'sync' })).toBe('Waiting for sync…');
    expect(turnAnnouncement('running', reply('', 'model down'))).toBe('Reply failed: model down');
    expect(turnAnnouncement('running', { ...reply('ok'), error: 'stream broke' })).toBe('Reply failed: stream broke');
  });
});

describe('turns (#63: one assistant block per turn)', () => {
  const tool = (id: string, path: string, writes = false) => ({ type: 'tool' as const, id, call: { id, tool: writes ? 'write' : 'read', status: 'completed' as const, path, writes } });
  const a = (id: string, parts: ChatMessage['parts'], extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', createdAt: 1, parts, ...extra });
  const u = (id: string, text: string): ChatMessage => ({ id, role: 'user', createdAt: 1, parts: [{ type: 'text', id: `${id}p`, text }] });

  it('merges consecutive assistant messages between user messages', () => {
    const t = turns([
      u('u1', 'hi'),
      a('a1', [tool('t1', 'x.md')], { model: 'ollama/qwen' }),
      a('a2', [tool('t2', 'y.md', true)], { error: 'boom' }),
      a('a3', [{ type: 'text', id: 'p3', text: 'done' }]),
      u('u2', 'again'),
      a('a4', [tool('t4', 'z.md', true)]),
    ]);
    expect(t.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const first = t[1]!;
    expect(first).toMatchObject({ role: 'assistant', id: 'a1', model: 'ollama/qwen', errors: ['boom'] });
    expect(first.role === 'assistant' && first.parts.map((p) => p.id)).toEqual(['t1', 't2', 'p3']);
    expect(first.role === 'assistant' && changedPaths(first.parts)).toEqual(['y.md']);
    expect(t[3]).toMatchObject({ role: 'assistant', id: 'a4', errors: [] });
  });
});

describe('toolLabel / toolHref', () => {
  const call = (o: Partial<ToolCall>): ToolCall => ({ id: 'c', tool: 'webfetch', status: 'completed', writes: false, ...o });

  it('a search shows its query', () => {
    expect(toolLabel(call({ tool: 'websearch', query: 'obsidian sync' }))).toBe('searched the web: "obsidian sync"');
  });

  it('a fetch shows host and path, shortening a long path to 60 characters', () => {
    expect(toolLabel(call({ url: 'https://example.com/a/b?x=1' }))).toBe('fetched example.com/a/b?x=1');
    const long = '/' + 'a'.repeat(100);
    const label = toolLabel(call({ url: `https://example.com${long}` }));
    expect(label.startsWith('fetched example.com/aaa')).toBe(true);
    expect(label.length).toBe('fetched example.com'.length + 60);
  });

  it('a refused fetch keeps its error chip label', () => {
    expect(toolLabel(call({ status: 'error', url: 'https://example.com/a', error: 'nope' }))).toBe('webfetch https://example.com/a');
    expect(toolLabel(call({ status: 'denied', url: 'https://example.com/a' }))).toBe('denied · webfetch https://example.com/a');
  });

  it('other tools are unchanged', () => {
    expect(toolLabel(call({ tool: 'read', path: 'a.md' }))).toBe('read a.md');
    expect(toolLabel(call({ tool: 'edit', writes: true, path: 'a.md' }))).toBe('changing a.md');
    expect(toolLabel(call({ tool: 'grep', status: 'error', title: 'x' }))).toBe('grep x');
  });

  it('open_url label is `open <host/path>`, href only when completed and http(s)', () => {
    const offer = (o: Partial<ToolCall>) => call({ tool: 'open_url', url: 'https://example.com/', ...o });
    expect(toolLabel(offer({}))).toBe('open example.com/');
    expect(toolLabel(offer({ url: 'https://en.wikipedia.org/wiki/Foo?x=1' }))).toBe('open en.wikipedia.org/wiki/Foo?x=1');
    expect(toolLabel(offer({ status: 'error', error: 'URL not in this chat' }))).toBe('open_url https://example.com/');
    expect(toolHref(offer({}))).toBe('https://example.com/');
    expect(toolHref(offer({ status: 'running' }))).toBeNull();
    expect(toolHref(offer({ status: 'error' }))).toBeNull();
    expect(toolHref(offer({ url: 'javascript:alert(1)' }))).toBeNull();
  });

  it('toolHref: the URL for a completed http(s) fetch, else null', () => {
    expect(toolHref(call({ url: 'https://example.com/a' }))).toBe('https://example.com/a');
    expect(toolHref(call({ url: 'http://example.com/a' }))).toBe('http://example.com/a');
    expect(toolHref(call({ url: 'javascript:alert(1)' }))).toBeNull();
    expect(toolHref(call({ tool: 'websearch', query: 'x' }))).toBeNull();
    expect(toolHref(call({ status: 'error', url: 'https://example.com/a' }))).toBeNull();
    expect(toolHref(call({ status: 'running', url: 'https://example.com/a' }))).toBeNull();
  });
});
