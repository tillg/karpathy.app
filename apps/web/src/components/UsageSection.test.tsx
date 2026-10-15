// @vitest-environment jsdom
import type { UsageReport } from '@karpathy/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { UsageSection } from './UsageSection';

const sums = (o: Partial<UsageReport['total']> = {}) => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...o });
const report = (n: number, costKnown: boolean): UsageReport => ({
  days: Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, ...sums({ input: 1000 }) })),
  byModel: [{ model: 'acme/model-a', ...sums({ input: 1_000_000, output: 100_000, reasoning: 50_000, cacheRead: 40_000, cacheWrite: 10_000, cost: costKnown ? 3.861 : 0 }) }],
  byVault: [{ vault: 'v1', name: 'My life', chats: 14, ...sums({ input: 1_000_000, output: 100_000, reasoning: 50_000, cacheRead: 40_000, cacheWrite: 10_000, cost: costKnown ? 3.861 : 0 }) }],
  total: sums({ input: 1_000_000, output: 100_000, reasoning: 50_000, cacheRead: 40_000, cacheWrite: 10_000, cost: costKnown ? 3.861 : 0 }),
  costKnown,
});
// total 1.2M, input 1.0M (83 %), output 150K (13 %)

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '#'); });

describe('Admin › Usage', () => {
  it('7 d / 30 d refetch with ?days=', async () => {
    const fetched: string[] = [];
    fakeApi({ routes: { 'GET /api/usage': () => report(7, true) } });
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => { if (url.includes('/usage')) fetched.push(url); return inner(url, init); });
    renderApp(<UsageSection />);
    await screen.findByText('Total tokens');
    expect(fetched.at(-1)).toMatch(/\/usage\?days=7$/);
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(fetched.at(-1)).toMatch(/\/usage\?days=30$/));
    expect(screen.getByRole('button', { name: '30 days' }).className).toMatch(/\bon\b/);
  });

  it('totals in short numbers (29K, 1.2M)', async () => {
    fakeApi({ routes: { 'GET /api/usage': report(7, true) } });
    renderApp(<UsageSection />);
    await screen.findByText('Total tokens');
    const tile = async (k: string) => [...document.querySelectorAll<HTMLElement>('.tile')].find((t) => t.querySelector('.k')!.textContent === k)!;
    expect((await tile('Total tokens')).textContent).toContain('1.2M');
    const input = await tile('Input');
    expect(input.textContent).toContain('1M');
    expect(input.textContent).toContain('83 %');
    const output = await tile('Output');
    expect(output.textContent).toContain('150K');
    expect(output.textContent).toContain('13 %');
    const model = within(screen.getByText('acme/model-a').closest('tr')!).getAllByRole('cell').map((c) => c.textContent);
    expect(model.slice(1, 4)).toEqual(['1M', '150K', '50K']);
    const vault = within(screen.getByText('My life').closest('tr')!).getAllByRole('cell').map((c) => c.textContent);
    expect(vault.slice(0, 3)).toEqual(['My life', '14', '1.2M']);
  });

  it('cost column only when costKnown', async () => {
    fakeApi({ routes: { 'GET /api/usage': report(7, true) } });
    const { unmount } = renderApp(<UsageSection />);
    await screen.findByText('Total tokens');
    expect(screen.getAllByRole('columnheader', { name: 'Cost' })).toHaveLength(2);
    expect(document.querySelector('.tiles')!.textContent).toContain('$3.86');
    unmount();
    cleanup();
    fakeApi({ routes: { 'GET /api/usage': report(7, false) } });
    renderApp(<UsageSection />);
    await screen.findByText('Total tokens');
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(3);
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it("shows 'Counts the chats that still exist.'", async () => {
    fakeApi({ routes: { 'GET /api/usage': report(7, true) } });
    renderApp(<UsageSection />);
    expect(await screen.findByText(/Counts the chats that still exist\./)).toBeTruthy();
  });

  it('stacked bars: one stack per day, labelled like "Oct 9"', async () => {
    fakeApi({ routes: { 'GET /api/usage': report(7, true) } });
    renderApp(<UsageSection />);
    const svg = await screen.findByRole('img', { name: 'Tokens per day' });
    expect(svg.querySelectorAll('g.stack')).toHaveLength(7);
    expect(svg.textContent).toContain('Oct 1');
  });

  it('error state', async () => {
    fakeApi({ routes: { 'GET /api/usage': () => { throw new Error('x'); } } });
    renderApp(<UsageSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
  });
});
