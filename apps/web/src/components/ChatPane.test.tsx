// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport, VAULT } from '../test/fake-api';
import { ChatPane } from './ChatPane';

beforeEach(() => {
  setViewport(false);
  // jsdom lacks ResizeObserver, which the message list uses.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const CHATS = `/api/vaults/${VAULT}/chats`;
const summary = (more: object = {}) => ({ id: 'c1', title: 'Old title', updatedAt: 1, turn: 'idle', ...more });
const detail = (more: object = {}) => ({ id: 'c1', title: 'Old title', messages: [], turn: 'idle', ...more });

async function openChat(routes: Record<string, unknown> = {}, list = [summary()]) {
  const api = fakeApi({ routes: { [`GET ${CHATS}`]: list, [`GET ${CHATS}/c1`]: detail({ titleSuggestion: 'New title' }), ...routes } });
  renderApp(<ChatPane />);
  fireEvent.click(await screen.findByTestId('chat-item'));
  return api;
}

describe('chat title suggestion (#148)', () => {
  it('shows a bar above the composer when the chat has a suggestion', async () => {
    await openChat();
    expect((await screen.findByTestId('chat-title-suggestion')).textContent).toContain('Rename this chat to “New title”?');
  });

  it('no bar without a suggestion', async () => {
    await openChat({ [`GET ${CHATS}/c1`]: detail() });
    await screen.findByTestId('chat-composer');
    expect(screen.queryByTestId('chat-title-suggestion')).toBeNull();
  });

  it('Rename PATCHes the title and hides the bar', async () => {
    const api = await openChat({ [`PATCH ${CHATS}/c1`]: undefined });
    fireEvent.click(await screen.findByTestId('chat-title-rename'));
    await waitFor(() => expect(screen.queryByTestId('chat-title-suggestion')).toBeNull());
    expect(api.calls).toContainEqual({ call: `PATCH ${CHATS}/c1`, body: { title: 'New title' } });
  });

  it('Keep DELETEs the suggestion and hides the bar', async () => {
    const api = await openChat({ [`DELETE ${CHATS}/c1/title-suggestion`]: undefined });
    fireEvent.click(await screen.findByTestId('chat-title-keep'));
    await waitFor(() => expect(screen.queryByTestId('chat-title-suggestion')).toBeNull());
    expect(api.calls.some((c) => c.call === `DELETE ${CHATS}/c1/title-suggestion`)).toBe(true);
  });

  it('a chat-title event shows the suggestion in the open chat and clears it when it is gone', async () => {
    const api = await openChat({ [`GET ${CHATS}/c1`]: detail() });
    await screen.findByTestId('chat-composer');
    act(() => api.emit({ type: 'chat-title', chatId: 'c1', title: 'Old title', titleSuggestion: 'Drifted' }));
    expect((await screen.findByTestId('chat-title-suggestion')).textContent).toContain('“Drifted”');
    act(() => api.emit({ type: 'chat-title', chatId: 'c1', title: 'Drifted' }));
    await waitFor(() => expect(screen.queryByTestId('chat-title-suggestion')).toBeNull());
  });

  it('a chat-title event reloads the chat list with the new title', async () => {
    let list = [summary()];
    const api = fakeApi({ routes: { [`GET ${CHATS}`]: () => list } });
    renderApp(<ChatPane />);
    expect((await screen.findByTestId('chat-item')).textContent).toContain('Old title');
    list = [summary({ title: 'Fresh title' })];
    act(() => api.emit({ type: 'chat-title', chatId: 'c1', title: 'Fresh title' }));
    await waitFor(() => expect(screen.getByTestId('chat-item').textContent).toContain('Fresh title'));
  });
});

describe('queued messages while the AI works (#155)', () => {
  const running = (more: object = {}) => detail({ turn: 'running', messages: [{ id: 'u1', role: 'user', createdAt: 1, parts: [{ type: 'text', id: 'p', text: 'first' }] }], ...more });

  it('the composer stays usable: typing shows Send next to Stop, and Send queues the message', async () => {
    const api = await openChat({ [`GET ${CHATS}/c1`]: running(), [`POST ${CHATS}/c1/prompt`]: { queued: true, id: 'q9' } });
    const box = await screen.findByTestId('chat-composer');
    await waitFor(() => expect(screen.getByTestId('chat-stop')).toBeTruthy());
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId('chat-send')).toBeNull();
    fireEvent.change(box, { target: { value: 'and then this' } });
    expect(screen.getByTestId('chat-stop')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chat-send'));
    const bubble = await screen.findByTestId('queued-prompt');
    expect(bubble.textContent).toContain('and then this');
    expect(bubble.textContent).toContain('Queued');
    expect(api.calls.find((c) => c.call === `POST ${CHATS}/c1/prompt`)?.body).toMatchObject({ text: 'and then this' });
    expect((box as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(screen.getByTestId('queued-prompt').getAttribute('data-id')).toBe('q9'));
    await screen.findByTestId('queued-edit');
  });

  it('messages sent in quick succession all go out, in order (none is dropped while the first is on its way)', async () => {
    let n = 0;
    const api = await openChat({ [`GET ${CHATS}/c1`]: running(), [`POST ${CHATS}/c1/prompt`]: () => ({ queued: true, id: `q${++n}` }) });
    const box = await screen.findByTestId('chat-composer');
    await screen.findByTestId('chat-stop');
    fireEvent.change(box, { target: { value: 'one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: 'two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.calls.filter((c) => c.call === `POST ${CHATS}/c1/prompt`).map((c) => (c.body as { text: string }).text)).toEqual(['one', 'two']));
    await waitFor(() => expect(screen.getAllByTestId('queued-prompt').map((e) => e.getAttribute('data-id'))).toEqual(['q1', 'q2']));
  });

  it('Edit takes a queued message back into the composer', async () => {
    const api = await openChat({
      [`GET ${CHATS}/c1`]: running({ queued: [{ id: 'q1', text: 'fix the typo' }] }),
      [`DELETE ${CHATS}/c1/queue/q1`]: { id: 'q1', text: 'fix the typo', attachments: [] },
    });
    fireEvent.click(await screen.findByTestId('queued-edit'));
    await waitFor(() => expect((screen.getByTestId('chat-composer') as HTMLTextAreaElement).value).toBe('fix the typo'));
    expect(api.calls.some((c) => c.call === `DELETE ${CHATS}/c1/queue/q1`)).toBe(true);
  });

  it('✕ removes a queued message and deletes its uploaded files', async () => {
    const api = await openChat({
      [`GET ${CHATS}/c1`]: running({ queued: [{ id: 'q1', text: 'look', attachments: ['Sources/upload-a/a.png'] }] }),
      [`DELETE ${CHATS}/c1/queue/q1`]: { id: 'q1', text: 'look', attachments: [{ path: 'Sources/upload-a/a.png', version: 'v1', mime: 'image/png', size: 3 }] },
      [`DELETE /api/vaults/${VAULT}/file`]: undefined,
    });
    fireEvent.click(await screen.findByTestId('queued-remove'));
    await waitFor(() => expect(screen.queryByTestId('queued-prompt')).toBeNull());
    expect(api.calls.some((c) => c.call === `DELETE /api/vaults/${VAULT}/file`)).toBe(true);
    expect((screen.getByTestId('chat-composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('Stop puts every queued message back into the composer, oldest first', async () => {
    await openChat({
      [`GET ${CHATS}/c1`]: running({ queued: [{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }] }),
      [`POST ${CHATS}/c1/abort`]: { restored: [{ id: 'q1', text: 'one', attachments: [] }, { id: 'q2', text: 'two', attachments: [] }] },
    });
    expect(await screen.findAllByTestId('queued-prompt')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('chat-stop'));
    await waitFor(() => expect((screen.getByTestId('chat-composer') as HTMLTextAreaElement).value).toBe('one\n\ntwo'));
    expect(screen.queryByTestId('queued-prompt')).toBeNull();
  });

  /** A chat stream the test feeds and ends; each request opens a new one. */
  const streams = () => {
    const open: ReadableStreamDefaultController<Uint8Array>[] = [];
    const route = () => new Response(new ReadableStream({ start: (c) => void open.push(c) }));
    const send = (e: object) => open.at(-1)!.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
    return { open, route, send, end: () => open.at(-1)!.close() };
  };
  /** A route that answers when the test says so. */
  const later = <T,>(value: T) => {
    let go!: () => void;
    const answered = new Promise<T>((r) => { go = () => r(value); });
    return { route: () => answered, go };
  };
  const STREAM = `GET ${CHATS}/c1/stream`;

  it('a message queued as the reply ends is followed: the chat reattaches after its POST, and the reload keeps the unsent bubble', async () => {
    let d = running();
    const s = streams();
    const post = later({ id: 'q1' });
    const api = await openChat({ [`GET ${CHATS}/c1`]: () => d, [STREAM]: s.route, [`POST ${CHATS}/c1/prompt`]: post.route });
    const box = await screen.findByTestId('chat-composer');
    await waitFor(() => expect(s.open).toHaveLength(1));
    fireEvent.change(box, { target: { value: 'and then this' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByTestId('queued-prompt');
    // The reply ends before the server has the message: the stream ends, the reload finds the chat idle.
    d = detail({ messages: running().messages, queued: [] });
    const gets = () => api.calls.filter((c) => c.call === `GET ${CHATS}/c1`).length;
    const before = gets();
    act(() => { s.send({ type: 'turn', state: 'idle' }); s.end(); });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('queued-prompt').textContent).toContain('and then this');
    // The server queued it and started it at once: the chat follows the new turn.
    d = running({ queued: [] });
    act(() => post.go());
    await waitFor(() => expect(s.open).toHaveLength(2));
  });

  it('Stop waits for a message still on its way, so it comes back instead of running after the Stop', async () => {
    const post = later({ id: 'q1' });
    const api = await openChat({
      [`GET ${CHATS}/c1`]: running(),
      [`POST ${CHATS}/c1/prompt`]: post.route,
      [`POST ${CHATS}/c1/abort`]: { restored: [{ id: 'q1', text: 'one more', attachments: [] }] },
    });
    const box = await screen.findByTestId('chat-composer');
    await screen.findByTestId('chat-stop');
    fireEvent.change(box, { target: { value: 'one more' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('chat-stop'));
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls.some((c) => c.call === `POST ${CHATS}/c1/abort`)).toBe(false);
    act(() => post.go());
    await waitFor(() => expect(api.calls.some((c) => c.call === `POST ${CHATS}/c1/abort`)).toBe(true));
    await waitFor(() => expect((screen.getByTestId('chat-composer') as HTMLTextAreaElement).value).toBe('one more'));
  });

  it('Stop puts the waiting first message and the queued ones back oldest first, whichever answer comes first', async () => {
    let d = detail();
    const s = streams();
    let n = 0;
    const abort = later({ restored: [{ id: 'a', text: 'A', attachments: [] }, { id: 'b', text: 'B', attachments: [] }, { id: 'c', text: 'C', attachments: [] }] });
    await openChat({ [`GET ${CHATS}/c1`]: () => d, [STREAM]: s.route, [`POST ${CHATS}/c1/prompt`]: () => ({ id: ['a', 'b', 'c'][n++] }), [`POST ${CHATS}/c1/abort`]: abort.route });
    const box = await screen.findByTestId('chat-composer');
    // A waits for the sync (sent while the chat was idle: the pending bubble), B and C queue behind it.
    d = detail({ turn: 'queued', queued: [{ id: 'a', text: 'A' }] });
    for (const text of ['A', 'B', 'C']) {
      fireEvent.change(box, { target: { value: text } });
      fireEvent.keyDown(box, { key: 'Enter' });
      if (text === 'A') await waitFor(() => expect(s.open).toHaveLength(1));
    }
    await waitFor(() => expect(screen.getAllByTestId('queued-prompt').map((e) => e.getAttribute('data-id'))).toEqual(['b', 'c']));
    fireEvent.click(screen.getByTestId('chat-stop'));
    // The idle event arrives before the answer of the Stop.
    d = detail();
    await waitFor(() => expect(s.open).toHaveLength(1));
    act(() => { s.send({ type: 'queue', queued: [] }); s.send({ type: 'turn', state: 'idle' }); s.end(); });
    await new Promise((r) => setTimeout(r, 50));
    act(() => abort.go());
    await waitFor(() => expect((screen.getByTestId('chat-composer') as HTMLTextAreaElement).value).toBe('A\n\nB\n\nC'));
  });
});

describe('error pill names its origin (#169)', () => {
  const failed = (errorOrigin?: object) => detail({ messages: [
    { id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', id: 'p0', text: 'search it' }] },
    { id: 'a', role: 'assistant', createdAt: 2, model: 'openrouter/qwen3-8b', parts: [], error: 'Insufficient credits', ...(errorOrigin ? { errorOrigin } : {}) },
  ] });

  it('a tool origin: the pill names the tool', async () => {
    await openChat({ [`GET ${CHATS}/c1`]: failed({ kind: 'tool', tool: 'websearch' }) });
    const pill = await screen.findByTestId('chat-error');
    expect(pill.textContent).toBe('During tool websearch: Insufficient credits');
    expect(pill.dataset.origin).toBe('tool');
  });

  it('a model origin: the pill names the model', async () => {
    await openChat({ [`GET ${CHATS}/c1`]: failed({ kind: 'model' }) });
    const pill = await screen.findByTestId('chat-error');
    expect(pill.textContent).toBe('From the model qwen3-8b: Insufficient credits');
    expect(pill.dataset.origin).toBe('model');
  });

  it('no origin: the message alone', async () => {
    await openChat({ [`GET ${CHATS}/c1`]: failed() });
    expect((await screen.findByTestId('chat-error')).textContent).toBe('Insufficient credits');
  });
});
