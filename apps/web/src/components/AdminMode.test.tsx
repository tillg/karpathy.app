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
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.hash).toBe(`#/${VAULT}/a.md`));
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
});
