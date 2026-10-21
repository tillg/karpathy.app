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
