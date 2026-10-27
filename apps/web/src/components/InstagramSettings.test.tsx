// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { Shell } from './Shell';
import { InstagramSettings } from './InstagramSettings';

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '#'); });

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

  it('the vault list shows "Instagram disconnected — N links waiting" when expired, and it opens Secrets & keys', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'expired', account: 'tillg', waitingLinks: 2 } } });
    history.replaceState(null, '', '#admin/vaults');
    renderApp(<Shell />);
    const notice = await screen.findByTestId('ig-notice');
    expect(notice.textContent).toMatch(/Instagram disconnected — 2 links waiting/);
    fireEvent.click(screen.getByTestId('ig-notice-open'));
    expect(await screen.findByTestId('admin-section-secrets')).toBeTruthy();
  });

  it('local mode is unchanged', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': { state: 'not-connected', waitingLinks: 2, source: 'local' } } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-status')).textContent).toBe('Not connected — 2 links waiting');
    expect(screen.getByTestId('ig-connect')).toBeTruthy();
    expect(screen.queryByTestId('ig-workers')).toBeNull();
    expect(screen.queryByTestId('ig-guide')).toBeNull();
  });
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const worker = (name: string, min: number, state = 'idle', message?: string) =>
  ({ name, version: '0.1.0', state, lastSeen: ago(min), ...(message ? { message } : {}) });
const queue = { waiting: 3, leased: 1, backingOff: 2, ready: 0, failed: 1 };
const workerStatus = (workers: object[], waitingLinks = 4) =>
  ({ state: 'not-connected', waitingLinks, source: 'worker', workers, queue });

describe('Admin › Instagram in worker mode', () => {
  it('worker mode lists each worker with last seen and state', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 3, 'scraping'), worker('pi', 180, 'rate-limited', 'Instagram says wait')]) } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-status')).textContent).toMatch(/Scraped by your workers — 4 links waiting/);
    const [mac, pi] = screen.getAllByTestId('ig-worker');
    expect([mac, pi].map((r) => r!.dataset.name)).toEqual(['mac', 'pi']);
    expect(mac!.textContent).toMatch(/mac.*last seen 3 min ago/);
    expect(mac!.textContent).toMatch(/Scraping/);
    expect(pi!.textContent).toMatch(/last seen 3 h ago/);
    expect(pi!.textContent).toMatch(/Rate-limited/);
    expect(pi!.textContent).toMatch(/Instagram says wait/);
  });

  it('worker mode hides the Connect form', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 1)]) } });
    renderApp(<InstagramSettings />);
    await screen.findByTestId('ig-workers');
    expect(screen.queryByTestId('ig-connect')).toBeNull();
    expect(screen.queryByTestId('ig-username')).toBeNull();
    expect(screen.queryByTestId('ig-disconnect')).toBeNull();
  });

  it('no worker seen yet says so', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([]) } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-workers')).textContent).toMatch(/No worker has reported yet/);
  });

  it('needs-login names the worker and the login command', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 2, 'needs-login')]) } });
    renderApp(<InstagramSettings />);
    const hint = await screen.findByTestId('ig-login-hint');
    expect(hint.textContent).toBe('Run karpathy-instagram-worker login on mac.');
    expect(screen.getByTestId('ig-worker').textContent).toMatch(/Needs login/);
  });

  it('the login hint keeps a hyphenated worker name on one line (phone width)', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('till-mbp', 2, 'needs-login')]) } });
    renderApp(<InstagramSettings />);
    const name = (await screen.findByTestId('ig-login-hint')).querySelector('.nowrap');
    expect(name?.textContent).toBe('till-mbp');
  });

  it('two workers seen within an hour show the one-account warning', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 5), worker('pi', 50)]) } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-two-workers')).textContent).toMatch(/one Instagram account per worker/);
    cleanup();

    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 5), worker('pi', 90)]) } });
    renderApp(<InstagramSettings />);
    await screen.findByTestId('ig-workers');
    expect(screen.queryByTestId('ig-two-workers')).toBeNull();
  });

  it('the counts line', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 1)]) } });
    renderApp(<InstagramSettings />);
    expect((await screen.findByTestId('ig-queue')).textContent).toBe('3 waiting · 1 in progress · 2 backing off · 1 failed');
  });

  it('the guide link points at docs/instagram-worker.md', async () => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([]) } });
    renderApp(<InstagramSettings />);
    const link = await screen.findByTestId('ig-guide');
    expect(link.getAttribute('href')).toBe('https://github.com/tillg/karpathy.app/blob/main/docs/instagram-worker.md');
    expect(link.textContent).toMatch(/Set up a worker/);
  });
});

describe('Vaults list › Instagram notice in worker mode', () => {
  const vaults = (status: object) => {
    fakeApi({ routes: { 'GET /api/ingest/instagram': status } });
    history.replaceState(null, '', '#admin/vaults');
    renderApp(<Shell />);
  };

  it('links waiting and no worker for an hour → notice', async () => {
    vaults(workerStatus([worker('mac', 61)], 2));
    const notice = await screen.findByTestId('ig-notice');
    expect(notice.textContent).toMatch(/2 Instagram links wait for a worker/);
    fireEvent.click(screen.getByTestId('ig-notice-open'));
    expect(await screen.findByTestId('admin-section-secrets')).toBeTruthy();
  });

  it('links waiting and no worker ever → notice', async () => {
    vaults(workerStatus([], 1));
    expect((await screen.findByTestId('ig-notice')).textContent).toMatch(/1 Instagram link waits for a worker/);
  });

  it('a worker seen 10 min ago → no notice', async () => {
    const api = fakeApi({ routes: { 'GET /api/ingest/instagram': workerStatus([worker('mac', 10)], 2) } });
    history.replaceState(null, '', '#admin/vaults');
    renderApp(<Shell />);
    await waitFor(() => expect(api.calls.some((c) => c.call === 'GET /api/ingest/instagram')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('ig-notice')).toBeNull();
  });

  it('needs-login → notice naming the worker', async () => {
    vaults(workerStatus([worker('mac', 2, 'needs-login')], 0));
    expect((await screen.findByTestId('ig-notice')).textContent).toMatch(/Instagram needs a login on mac/);
  });
});
