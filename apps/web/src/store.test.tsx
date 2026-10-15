// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './lib/api';
import { useApp, type AppState } from './store';
import { fakeApi, renderApp, setViewport, VAULT } from './test/fake-api';

let app: AppState;
function Probe() {
  app = useApp();
  return null;
}

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '/'); });

describe('newNote (#126)', () => {
  const created = async (path: string) => {
    const api = fakeApi({ routes: { [`PUT /api/vaults/${VAULT}/file`]: { version: 'v' } } });
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    await act(() => app.newNote(path));
    return (api.calls.find((c) => c.call === `PUT /api/vaults/${VAULT}/file`)?.body as { content: string } | undefined)?.content;
  };

  it('a note starts with its title', async () => {
    expect(await created('a/x.md')).toBe('# x\n');
  });

  it('a .markdown note starts with its title', async () => {
    expect(await created('a/x.markdown')).toBe('# x\n');
  });

  it('a code file starts empty', async () => {
    expect(await created('a/run.py')).toBe('');
  });

  it('an HTML page starts empty', async () => {
    expect(await created('a/page.html')).toBe('');
  });
});

describe('back arrow state (#139)', () => {
  const file = { [`GET /api/vaults/${VAULT}/file`]: { path: 'x', content: '# x\n', version: 'v', binary: false } };

  it('opening B after A sets prev = A and canGoBack; the first file has none', async () => {
    fakeApi({ routes: file });
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    await act(() => app.openNote('A.md'));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/A.md`));
    expect(app.canGoBack).toBe(false);
    await act(() => app.openNote('B.md'));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/B.md`));
    expect(history.state).toEqual({ prev: 'A.md' });
    expect(app.canGoBack).toBe(true);
  });

  it('Back to A: canGoBack follows A\'s entry', async () => {
    fakeApi({ routes: file });
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    await act(() => app.openNote('A.md'));
    await act(() => app.openNote('B.md'));
    await waitFor(() => expect(app.canGoBack).toBe(true));
    act(() => app.goBack());
    await waitFor(() => expect(app.note?.path).toBe('A.md'));
    await waitFor(() => expect(app.canGoBack).toBe(false));
  });

  it('a deep-linked first file stays without a previous file after Back to it', async () => {
    fakeApi({ routes: file });
    history.replaceState(null, '', `/#/${VAULT}/A.md`);
    renderApp(<Probe />);
    await waitFor(() => expect(app.note?.path).toBe('A.md'));
    await act(() => app.openNote('B.md'));
    await waitFor(() => expect(app.canGoBack).toBe(true));
    act(() => history.back());
    await waitFor(() => expect(app.note?.path).toBe('A.md'));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/A.md`));
    expect(history.state).toEqual({ prev: null });
    expect(app.canGoBack).toBe(false);
  });
});

describe('page mode (#126)', () => {
  it('a new browser opens HTML pages in Read and notes in Write', async () => {
    fakeApi();
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    expect(app.pageMode).toBe('read');
    expect(app.mode).toBe('write');
  });

  it('switching on a page leaves the notes\' mode, and the other way round', async () => {
    fakeApi();
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    act(() => app.setMode('read'));
    act(() => app.setPageMode('write'));
    expect(app.pageMode).toBe('write');
    expect(app.mode).toBe('read');
    act(() => app.setMode('write'));
    expect(app.mode).toBe('write');
    expect(app.pageMode).toBe('write');
  });

  it('the page mode survives a reload', async () => {
    fakeApi();
    localStorage.setItem('karpathy.pageMode', 'write');
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    expect(app.pageMode).toBe('write');
  });
});

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

describe('open page (#143)', () => {
  const file = { [`GET /api/vaults/${VAULT}/file`]: { path: 'x', content: '# x\n', version: 'v', binary: false } };

  it('is none without a note, then the open note with its mode and unsaved state', async () => {
    fakeApi({ routes: file });
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    expect(app.openPage()).toBeUndefined();
    await act(() => app.openNote('notes/A.md'));
    await waitFor(() => expect(app.note?.path).toBe('notes/A.md'));
    expect(app.openPage()).toEqual({ path: 'notes/A.md', mode: 'write', unsaved: false });
    act(() => app.setMode('read'));
    expect(app.openPage()?.mode).toBe('read');
  });

  it('a prompt sends it in the body, and nothing when none is open', async () => {
    const fake = fakeApi({ routes: { [`POST /api/vaults/${VAULT}/chats/c1/prompt`]: { queued: true } } });
    await api.prompt(VAULT, 'c1', 'hi', undefined, { path: 'A.md', mode: 'read', unsaved: true });
    await api.prompt(VAULT, 'c1', 'hi');
    const bodies = fake.calls.filter((c) => c.call.endsWith('/prompt')).map((c) => c.body);
    expect(bodies).toEqual([{ text: 'hi', openPage: { path: 'A.md', mode: 'read', unsaved: true } }, { text: 'hi' }]);
  });
});

describe('vault commands (#134)', () => {
  it('a skill file changed outside a pull makes the command list reload', async () => {
    const api = fakeApi();
    renderApp(<Probe />);
    await waitFor(() => expect(app.usable).toBe(true));
    await waitFor(() => expect(api.calls.some((c) => c.call === `GET /api/vaults/${VAULT}/events`)).toBe(true));
    const before = app.commandsNonce;
    act(() => api.emit({ type: 'files-changed', files: [{ path: 'notes/a.md', version: 'v' }] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(app.commandsNonce).toBe(before);
    act(() => api.emit({ type: 'files-changed', files: [{ path: '.agents/skills/x/SKILL.md', version: 'v' }] }));
    await waitFor(() => expect(app.commandsNonce).toBe(before + 1));
  });
});

describe('Done after deleting the active vault (#150)', () => {
  it('going back to the deleted vault\'s route does not make it active again', async () => {
    const v = (id: string) => ({ id, name: id, repo: `o/${id}`, branch: 'main', root: '', state: 'ready' });
    let list = [v(VAULT), v('v2')];
    fakeApi({ routes: {
      'GET /api/vaults': () => list,
      'POST /api/vaults/v2/open': { state: 'ready', changedCount: 0, inputChangedCount: 0, unpushedCount: 0, incomingCount: 0, incomingPaths: [], busy: 'none', conflictPaths: [] },
      'GET /api/vaults/v2/files': [], 'GET /api/vaults/v2/commands': [], 'GET /api/vaults/v2/chats': [],
    } });
    history.replaceState(null, '', `#/${VAULT}`);
    const seen: (string | null)[] = [];
    function Spy() { app = useApp(); seen.push(app.activeId); return null; }
    renderApp(<Spy />);
    await waitFor(() => expect(app.activeId).toBe(VAULT));
    await act(() => app.openAdmin('vaults', VAULT));
    list = [v('v2')];
    await act(() => app.reloadVaults());
    await waitFor(() => expect(app.activeId).toBe('v2'));
    const from = seen.length;
    act(() => app.closeAdmin());
    await waitFor(() => expect(app.admin).toBeNull());
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.slice(from)).not.toContain(VAULT);
    expect(app.activeId).toBe('v2');
    expect(location.hash).toBe('#/v2');
  });
});
