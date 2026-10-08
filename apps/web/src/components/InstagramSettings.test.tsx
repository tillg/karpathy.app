// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { Admin } from './Admin';
import { InstagramSettings } from './InstagramSettings';

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const type = (testid: string, value: string) => fireEvent.change(screen.getByTestId(testid), { target: { value } });

describe('Admin › Instagram', () => {
  it('form → code field when the API answers code ("Code sent by SMS") → "Connected as @x"', async () => {
    let state: object = { state: 'not-connected', waitingLinks: 0 };
    const api = fakeApi({
      routes: {
        'GET /api/ingest/instagram': () => state,
        'POST /api/ingest/instagram/login': () => ({ state: 'code', via: 'SMS' }),
        'POST /api/ingest/instagram/code': () => (state = { state: 'connected', account: 'tillg', waitingLinks: 0 }, { state: 'connected', account: 'tillg' }),
      },
    });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-status')).textContent).toMatch(/Not connected/);
    type('ig-username', '@tillg');
    type('ig-password', 'pw');
    fireEvent.click(screen.getByTestId('ig-connect'));
    expect((await screen.findByTestId('ig-code-hint')).textContent).toBe('Code sent by SMS');
    expect(screen.queryByTestId('ig-password')).toBeNull();
    type('ig-code', '123456');
    fireEvent.click(screen.getByTestId('ig-verify'));
    await waitFor(() => expect(screen.getByTestId('ig-status').textContent).toMatch(/Connected as @tillg/));
    expect(api.calls.filter((c) => c.call.startsWith('POST /api/ingest/')).map((c) => [c.call, c.body])).toEqual([
      ['POST /api/ingest/instagram/login', { username: 'tillg', password: 'pw' }],
      ['POST /api/ingest/instagram/code', { code: '123456' }],
    ]);
  });

  it('error text for a wrong password; the password field is emptied', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'not-connected', waitingLinks: 0 } } });
    vi.stubGlobal('fetch', ((orig) => async (url: string, init?: RequestInit) =>
      url.endsWith('/ingest/instagram/login')
        ? new Response(JSON.stringify({ error: 'Wrong username or password', code: 'wrong-password' }), { status: 400 })
        : orig(url, init))(fetch));
    renderApp(<InstagramSettings />);
    await screen.findByTestId('ig-status');
    type('ig-username', 'tillg');
    type('ig-password', 'nope');
    fireEvent.click(screen.getByTestId('ig-connect'));
    expect((await screen.findByTestId('ig-error')).textContent).toMatch(/Wrong username or password/);
    expect((screen.getByTestId('ig-password') as HTMLInputElement).value).toBe('');
  });

  it('expired status shows Reconnect; connected shows Disconnect', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'expired', account: 'tillg', waitingLinks: 3 } } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-status')).textContent).toMatch(/Expired.*@tillg.*3 links waiting/);
    expect(screen.getByTestId('ig-connect').textContent).toBe('Reconnect');
    cleanup();

    const api = fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'connected', account: 'tillg', waitingLinks: 0 }, 'POST /api/ingest/instagram/disconnect': { state: 'not-connected', waitingLinks: 0 } } });
    renderApp(<InstagramSettings />);
    fireEvent.click(await screen.findByTestId('ig-disconnect'));
    await waitFor(() => expect(screen.getByTestId('ig-status').textContent).toMatch(/Not connected/));
    expect(api.calls.some((c) => c.call === 'POST /api/ingest/instagram/disconnect')).toBe(true);
  });

  it('says so when the ingest service is not running', async () => {
    fakeApi();
    vi.stubGlobal('fetch', ((orig) => async (url: string, init?: RequestInit) =>
      url.endsWith('/ingest/instagram')
        ? new Response(JSON.stringify({ error: 'Ingest service not running', code: 'ingest-down' }), { status: 503 })
        : orig(url, init))(fetch));
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-status')).textContent).toMatch(/Ingest service not running/);
    expect(screen.queryByTestId('ig-connect')).toBeNull();
  });

  it('the vault list shows "Instagram disconnected — N links waiting" when expired, and it opens Settings', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'expired', account: 'tillg', waitingLinks: 2 } } });
    renderApp(<Admin />);
    const notice = await screen.findByTestId('ig-notice');
    expect(notice.textContent).toMatch(/Instagram disconnected — 2 links waiting/);
    fireEvent.click(screen.getByTestId('ig-notice-open'));
    expect(await screen.findByTestId('settings-dialog')).toBeTruthy();
  });
});
