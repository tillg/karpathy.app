// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp, type AppState } from './store';
import { fakeApi, renderApp, setViewport, VAULT } from './test/fake-api';

let app: AppState;
function Probe() {
  app = useApp();
  return null;
}

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('ingestNow', () => {
  it('ingestNow creates a chat and sends /ingest', async () => {
    const api = fakeApi({
      routes: {
        [`POST /api/vaults/${VAULT}/chats`]: { chatId: 'c9' },
        [`POST /api/vaults/${VAULT}/chats/c9/prompt`]: { queued: false },
      },
    });
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    await act(() => app.ingestNow());
    const chatCalls = api.calls.filter((c) => c.call.startsWith(`POST /api/vaults/${VAULT}/chats`));
    expect(chatCalls).toEqual([
      { call: `POST /api/vaults/${VAULT}/chats`, body: undefined },
      { call: `POST /api/vaults/${VAULT}/chats/c9/prompt`, body: { text: '/ingest' } },
    ]);
    expect(app.chatId).toBe('c9');
    expect(app.chatOpen).toBe(true);
  });
});
