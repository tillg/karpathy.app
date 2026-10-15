// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport, VAULT } from '../test/fake-api';
import { SecretTable } from './SecretTable';
import { Shell } from './Shell';

const s = (name: string, o: object = {}) => ({ name, component: 'backend', purpose: `Purpose of ${name}`, optional: false, set: true, ...o });
const SECRETS = [
  s('bearer_token', { purpose: 'App login token' }),
  s('opencode_password', { component: 'opencode', purpose: 'opencode password' }),
  s('exa_api_key', { component: 'opencode', purpose: 'Web search (Exa)', optional: true, set: false }),
];

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '#'); });

describe('Admin › Deployment secrets', () => {
  it('one row per secret: purpose, name, component, Set / Missing / Not set (optional)', async () => {
    fakeApi({ routes: { 'GET /api/settings/secrets': { secrets: [...SECRETS, s('dns_api_token', { purpose: 'DNS', component: 'proxy', set: false })] } } });
    renderApp(<SecretTable />);
    const rows = await screen.findAllByTestId('secret-row');
    expect(rows).toHaveLength(4);
    const cells = (r: HTMLElement) => within(r).getAllByRole('cell').map((c) => c.textContent!.replace(/^(checkmark_alt|xmark|minus)/, ''));
    expect(cells(rows[0]!)).toEqual(['App login tokenbearer_token', 'bearer_token', 'backend', 'Set']);
    expect(cells(rows[1]!)[3]).toBe('Set');
    expect(cells(rows[2]!)).toEqual(['Web search (Exa)exa_api_key', 'exa_api_key', 'opencode', 'Not set (optional)']);
    expect(cells(rows[3]!)[3]).toBe('Missing');
    expect(screen.getByText(/never its value/)).toBeTruthy();
  });

  it('a missing required secret is flagged', async () => {
    fakeApi({ routes: { 'GET /api/settings/secrets': { secrets: [...SECRETS, s('dns_api_token', { set: false })] } } });
    renderApp(<SecretTable />);
    const count = await screen.findByTestId('secret-count');
    expect(count.textContent).toContain('2 of 4 set');
    expect(count.className).toMatch(/\bbad\b/);
    expect(screen.getAllByTestId('secret-row')[3]!.querySelector('.status')!.className).toMatch(/\bbad\b/);
  });

  it('only an unset optional secret is not a warning', async () => {
    fakeApi({ routes: { 'GET /api/settings/secrets': { secrets: SECRETS } } });
    renderApp(<SecretTable />);
    expect((await screen.findByTestId('secret-count')).className).toMatch(/\bok\b/);
  });

  it('a failed fetch shows a short inline error', async () => {
    fakeApi({ routes: { 'GET /api/settings/secrets': () => { throw new Error('boom'); } } });
    renderApp(<SecretTable />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/secrets/i);
  });

  it("the phone list row summarizes 'N of M set'", async () => {
    setViewport(true);
    history.replaceState(null, '', '#admin');
    fakeApi({ routes: { 'GET /api/settings/secrets': { secrets: SECRETS }, [`GET /api/vaults/${VAULT}/file`]: { path: 'a.md', content: '', binary: false, version: '1' } } });
    renderApp(<Shell />);
    const row = await screen.findByTestId('admin-row-secrets');
    await waitFor(() => expect(row.textContent).toContain('2 of 3 set'));
  });
});
