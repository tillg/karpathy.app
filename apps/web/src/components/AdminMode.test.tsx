// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport, VAULT } from '../test/fake-api';
import { Shell } from './Shell';

const NOTE = { path: 'a.md', content: '# A\n', binary: false, version: '1' };
const open = (routes: Record<string, unknown> = {}) => {
  history.replaceState(null, '', `#/${VAULT}/a.md`);
  const api = fakeApi({ routes: { [`GET /api/vaults/${VAULT}/file`]: NOTE, ...routes } });
  renderApp(<Shell />);
  return api;
};
const noteOpen = (api: { calls: { call: string }[] }) => waitFor(() => expect(api.calls.some((c) => c.call === `GET /api/vaults/${VAULT}/file`)).toBe(true));
const rail = () => document.querySelector('nav.admin-rail') as HTMLElement | null;
/** Admin mode's effects have run (the heading took focus), so its Escape listener is attached: the hash alone is too early on a slow runner. */
const adminReady = () => waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'General' })));

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '#'); });

describe('admin mode', () => {
  it('gear opens admin mode on General, Done returns to the note', async () => {
    const api = open();
    await noteOpen(api);
    expect(screen.getByRole('main', { name: 'Note' })).toBeTruthy();
    fireEvent.click(await screen.findByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    expect(within(rail()!).getAllByRole('link').map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('General'), expect.stringContaining('Vaults'), expect.stringContaining('Secrets'), expect.stringContaining('AI'), expect.stringContaining('Usage'), expect.stringContaining('Server')]));
    expect(within(rail()!).getAllByRole('link')).toHaveLength(6);
    expect(screen.queryByRole('main', { name: 'Note' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    expect(rail()).toBeNull();
    expect(screen.getByRole('main', { name: 'Note' })).toBeTruthy();
  });

  it('phone: the section list has Done, a row pushes the section, the section has "‹ Admin" and no Done, Back returns to the list, Done on the list returns to the note', async () => {
    setViewport(true);
    const api = open();
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin'));
    expect(screen.queryByRole('navigation', { name: 'Tabs' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Admin' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(6);
    fireEvent.click(screen.getByRole('link', { name: /Vaults/ }));
    await waitFor(() => expect(location.hash).toBe('#admin/vaults'));
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Admin/ }));
    await waitFor(() => expect(location.hash).toBe('#admin'));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    expect(screen.getByRole('main', { name: 'Note' })).toBeTruthy();
  });

  it('switching sections replaces the history entry', async () => {
    const api = open();
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    fireEvent.click(within(rail()!).getByRole('link', { name: /Server/ }));
    await waitFor(() => expect(location.hash).toBe('#admin/server'));
    expect(screen.getByRole('heading', { name: 'Server' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
  });

  it('Escape leaves admin mode on wide screens', async () => {
    const api = open();
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    await adminReady();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
  });

  it('entering admin mode focuses the section heading; Done and Escape return focus to the gear', async () => {
    const api = open();
    await noteOpen(api);
    const gear = await screen.findByTestId('open-settings');
    gear.focus();
    fireEvent.click(gear);
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'General' })));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('open-settings')));
    screen.getByTestId('open-settings').focus();
    fireEvent.click(screen.getByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    await adminReady();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('open-settings')));
  });

  it('Escape in admin mode does not close the graph underneath', async () => {
    const api = open();
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('open-graph'));
    await waitFor(() => expect((screen.getByTestId('graph-pane') as HTMLElement).hidden).toBe(false));
    fireEvent.click(screen.getByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    await adminReady();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    expect((screen.getByTestId('graph-pane') as HTMLElement).hidden).toBe(false);
  });

  it('Escape in an admin text field keeps admin mode and the typed text', async () => {
    const api = open({ 'GET /api/settings': { commitReminderThreshold: 20, model: 'x/y', webAccess: false, githubToken: { source: 'none', last4: null }, modelInput: null } });
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('open-settings'));
    const field = (await screen.findByTestId('settings-threshold')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '33' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 100));
    expect(location.hash).toBe('#admin/general');
    expect((screen.getByTestId('settings-threshold') as HTMLInputElement).value).toBe('33');
  });

  it('tablet: opening admin mode from the overlay sidebar closes it, and Escape returns focus to the sidebar toggle', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const api = open();
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('sidebar-toggle'));
    const gear = await screen.findByTestId('open-settings');
    gear.focus();
    fireEvent.click(gear);
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    expect(document.getElementById('scrim')!.className).not.toContain('on');
    await adminReady();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('sidebar-toggle')));
  });

  it('the vault switcher stays in user mode and switches vaults as before; admin mode shows none', async () => {
    const api = open({
      'GET /api/vaults': [{ id: VAULT, name: 'One', repo: 'o/r', branch: 'main', state: 'ready' }, { id: 'v2', name: 'Two', repo: 'o/s', branch: 'main', state: 'ready' }],
      'POST /api/vaults/v2/open': { state: 'ready', changedCount: 0, inputChangedCount: 0, unpushedCount: 0, incomingCount: 0, incomingPaths: [], busy: 'none', conflictPaths: [] },
      'GET /api/vaults/v2/files': [], 'GET /api/vaults/v2/commands': [], 'GET /api/vaults/v2/chats': [],
    });
    await noteOpen(api);
    fireEvent.click(await screen.findByTestId('vault-switcher'));
    fireEvent.click(await screen.findByText('Two'));
    await waitFor(() => expect(location.hash).toBe('#/v2'));
    fireEvent.click(screen.getByTestId('open-settings'));
    await waitFor(() => expect(location.hash).toBe('#admin/general'));
    expect(document.querySelector('#admin-mode [data-testid="vault-switcher"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Two/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(location.hash).toBe('#/v2'));
    expect(screen.getByTestId('vault-switcher')).toBeTruthy();
  });

  describe('sections hold the moved forms', () => {
    const SETTINGS = { commitReminderThreshold: 20, model: 'x/y', defaultModel: 'p/default', modelOverridden: true, titleModel: 'x/y', defaultTitleModel: 'x/y', titleModelOverridden: false, visionModel: 'g/v', defaultVisionModel: 'g/v', visionModelOverridden: false, visionGateway: 'g', webAccess: false, githubToken: { source: 'none', last4: null }, modelInput: null };
    const VAULTS = [{ id: VAULT, name: 'One', repo: 'o/r', branch: 'main', root: '', state: 'ready' }];
    const inAdmin = async (section: string, routes: Record<string, unknown> = {}) => {
      const api = open({ 'GET /api/settings': SETTINGS, 'GET /api/vaults': VAULTS, 'GET /api/health': { backend: 'ok', opencode: 'ok', version: '9.9.9', built: null, deployed: null }, 'GET /api/ingest/instagram': { state: 'not-connected', waitingLinks: 0 }, ...routes });
      await noteOpen(api);
      fireEvent.click(await screen.findByTestId('open-settings'));
      await waitFor(() => expect(location.hash).toBe('#admin/general'));
      if (section !== 'general') fireEvent.click(screen.getByTestId(`admin-nav-${section}`));
      return api;
    };
    const sec = (id: string) => within(screen.getByTestId(`admin-section-${id}`));
    const patches = (api: { calls: { call: string; body: unknown }[] }) => api.calls.filter((c) => c.call === 'PATCH /api/settings').map((c) => c.body);

    it('General: threshold + versions; Save sends only the threshold', async () => {
      const api = await inAdmin('general', { 'PATCH /api/settings': (b: object) => ({ ...SETTINGS, ...b }) });
      expect(((await sec('general').findByTestId('settings-threshold')) as HTMLInputElement).value).toBe('20');
      expect((await sec('general').findByTestId('version-server')).textContent).toBe('9.9.9');
      expect(sec('general').queryByTestId('settings-model')).toBeNull();
      fireEvent.change(sec('general').getByTestId('settings-threshold'), { target: { value: '30' } });
      fireEvent.click(sec('general').getByTestId('settings-save'));
      await waitFor(() => expect(patches(api)).toEqual([{ commitReminderThreshold: 30 }]));
    });

    it('Vaults: list + Add vault; vault details are a sub-view', async () => {
      await inAdmin('vaults');
      expect((await sec('vaults').findAllByTestId('admin-vault'))).toHaveLength(1);
      fireEvent.click(sec('vaults').getByTestId('admin-open-add'));
      expect(sec('vaults').getByTestId('admin-add').textContent).toBe('Add vault');
      fireEvent.click(sec('vaults').getByTestId('admin-back'));
      fireEvent.click(await sec('vaults').findByTestId('admin-vault'));
      expect(sec('vaults').getByTestId('vault-details')).toBeTruthy();
    });

    it('Vaults: a muted line says that switching vaults stays in user mode', async () => {
      await inAdmin('vaults');
      await sec('vaults').findAllByTestId('admin-vault');
      expect(sec('vaults').getByText('Switching between vaults stays in your notes (the vault menu). Here you add, edit and remove them.').className).toContain('muted');
    });

    it('Secrets & keys: GitHub token form and Instagram', async () => {
      await inAdmin('secrets');
      expect(sec('secrets').getByTestId('token-input')).toBeTruthy();
      expect(await sec('secrets').findByTestId('ig-status')).toBeTruthy();
    });

    it('AI: model, default, web access; Save sends only model and webAccess', async () => {
      const api = await inAdmin('ai', { 'PATCH /api/settings': (b: object) => ({ ...SETTINGS, ...b }) });
      expect(((await sec('ai').findByTestId('settings-model')) as HTMLInputElement).value).toBe('x/y');
      expect(sec('ai').getByTestId('settings-model-default').textContent).toMatch(/p\/default/);
      expect(sec('ai').queryByTestId('settings-threshold')).toBeNull();
      fireEvent.click(sec('ai').getByTestId('settings-model-reset'));
      fireEvent.click(sec('ai').getByTestId('settings-web-access'));
      fireEvent.click(sec('ai').getByTestId('settings-save'));
      await waitFor(() => expect(patches(api)).toEqual([{ model: 'p/default', webAccess: true }]));
    });

    it('AI: title and vision model fields, defaults, Use default; Save sends only changed ones (default = null)', async () => {
      const api = await inAdmin('ai', { 'PATCH /api/settings': (b: object) => ({ ...SETTINGS, ...b }) });
      const title = (await sec('ai').findByTestId('settings-title-model')) as HTMLInputElement;
      const vision = sec('ai').getByTestId('settings-vision-model') as HTMLInputElement;
      expect(title.value).toBe('x/y');
      expect(vision.value).toBe('g/v');
      expect(sec('ai').getByText('Writes the chat titles. Starts as the chat model.')).toBeTruthy();
      expect(sec('ai').getByText('A model of the g gateway that reads images (look_at_image).')).toBeTruthy();
      expect(sec('ai').queryByTestId('settings-title-model-reset')).toBeNull();
      expect(sec('ai').queryByTestId('settings-vision-model-reset')).toBeNull();
      fireEvent.change(title, { target: { value: 'x/small' } });
      fireEvent.change(vision, { target: { value: 'g/other' } });
      fireEvent.click(sec('ai').getByTestId('settings-save'));
      await waitFor(() => expect(patches(api)).toEqual([{ model: 'x/y', webAccess: false, titleModel: 'x/small', visionModel: 'g/other' }]));
    });

    it('AI: Use default on the title model sends null', async () => {
      const api = await inAdmin('ai', { 'GET /api/settings': { ...SETTINGS, titleModel: 'x/small', titleModelOverridden: true }, 'PATCH /api/settings': (b: object) => ({ ...SETTINGS, ...b }) });
      expect(((await sec('ai').findByTestId('settings-title-model')) as HTMLInputElement).value).toBe('x/small');
      expect(sec('ai').getByTestId('settings-title-model-default').textContent).toBe('Default: x/y');
      fireEvent.click(sec('ai').getByTestId('settings-title-model-reset'));
      expect((sec('ai').getByTestId('settings-title-model') as HTMLInputElement).value).toBe('x/y');
      fireEvent.click(sec('ai').getByTestId('settings-save'));
      await waitFor(() => expect(patches(api)).toEqual([{ model: 'x/y', webAccess: false, titleModel: null }]));
    });

    it('AI: an unset title model follows the chat model; without a vision gateway there is no vision field', async () => {
      const api = await inAdmin('ai', { 'GET /api/settings': { ...SETTINGS, titleModel: '', defaultTitleModel: '', visionGateway: '' }, 'PATCH /api/settings': (b: object) => ({ ...SETTINGS, ...b }) });
      const title = (await sec('ai').findByTestId('settings-title-model')) as HTMLInputElement;
      expect(title.value).toBe('');
      expect(title.placeholder).toBe('Same as the chat model');
      expect(sec('ai').getByTestId('settings-title-model-default').textContent).toBe('Default: the chat model');
      expect(sec('ai').queryByTestId('settings-title-model-reset')).toBeNull();
      expect(sec('ai').queryByTestId('settings-vision-model')).toBeNull();
      fireEvent.change(title, { target: { value: 'x/small' } });
      fireEvent.click(sec('ai').getByTestId('settings-title-model-reset'));
      expect(title.value).toBe('');
      fireEvent.change(title, { target: { value: 'x/small' } });
      fireEvent.click(sec('ai').getByTestId('settings-save'));
      await waitFor(() => expect(patches(api)).toEqual([{ model: 'x/y', webAccess: false, titleModel: 'x/small' }]));
    });

    it('"Manage vaults…" opens #admin/vaults; "Edit vault" opens that vault\'s details', async () => {
      await inAdmin('general');
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
      fireEvent.click(await screen.findByTestId('vault-switcher'));
      fireEvent.click(await screen.findByTestId('manage-vaults'));
      await waitFor(() => expect(location.hash).toBe('#admin/vaults'));
      expect(await sec('vaults').findAllByTestId('admin-vault')).toHaveLength(1);
      expect(sec('vaults').queryByTestId('vault-details')).toBeNull();
    });

    it('the vault-failed "Edit vault" opens the vault details', async () => {
      history.replaceState(null, '', `#/${VAULT}`);
      fakeApi({ routes: { 'GET /api/settings': SETTINGS, 'GET /api/vaults': [{ ...VAULTS[0], state: 'clone-failed', error: 'boom' }], [`POST /api/vaults/${VAULT}/open`]: { state: 'clone-failed' } } });
      renderApp(<Shell />);
      fireEvent.click(await screen.findByTestId('manage-vaults-cta'));
      await waitFor(() => expect(location.hash).toBe('#admin/vaults'));
      expect((await sec('vaults').findByTestId('vault-details')).getAttribute('data-vault')).toBe(VAULT);
    });

    it('the vault details open once: a later visit to Vaults shows the list', async () => {
      history.replaceState(null, '', `#/${VAULT}`);
      fakeApi({ routes: { 'GET /api/settings': SETTINGS, 'GET /api/vaults': [{ ...VAULTS[0], state: 'clone-failed', error: 'boom' }], [`POST /api/vaults/${VAULT}/open`]: { state: 'clone-failed' } } });
      renderApp(<Shell />);
      fireEvent.click(await screen.findByTestId('manage-vaults-cta'));
      await screen.findByTestId('vault-details');
      fireEvent.click(screen.getByTestId('admin-nav-general'));
      fireEvent.click(screen.getByTestId('admin-nav-vaults'));
      expect(await sec('vaults').findAllByTestId('admin-vault')).toHaveLength(1);
      expect(sec('vaults').queryByTestId('vault-details')).toBeNull();
    });
  });
});
