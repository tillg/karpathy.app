// @vitest-environment jsdom
import type { MetricsReport, MetricsSample } from '@karpathy/shared';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { ServerSection } from './ServerSection';

const GB = 1024 ** 3;
const sample = (i: number, o: Partial<MetricsSample> = {}): MetricsSample => ({
  at: 1_000_000 + i * 30_000, cpu: 20 + i, memUsed: 3.4 * GB, memTotal: 4 * GB, load1: 0.5 + i / 10,
  vaultsUsed: 8.5 * GB, vaultsTotal: 20 * GB, configUsed: 0.2 * GB, configTotal: 1 * GB, opencodeUp: true, ...o,
});
const report = (o: Partial<MetricsSample> = {}): MetricsReport => {
  const samples = [sample(0), sample(1), sample(2, o)];
  return { samples, latest: samples[2]!, uptimeS: 7 * 3600 + 41 * 60, intervalS: 30 };
};
const card = (title: string) => [...document.querySelectorAll<HTMLElement>('.chart-card')].find((c) => c.querySelector('h3 span')!.textContent === title)!;

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '#'); });

describe('Admin › Server', () => {
  it('one sparkline per metric with the latest value', async () => {
    fakeApi({ routes: { 'GET /api/metrics': report() } });
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    for (const t of ['CPU', 'Memory', 'Load', 'Disk · vaults', 'Disk · config']) expect(screen.getByRole('img', { name: t })).toBeTruthy();
    expect(document.querySelectorAll('.chart-card')).toHaveLength(5);
    expect(card('CPU').querySelector('.cur')!.textContent).toBe('22 %');
    expect(card('Memory').querySelector('.cur')!.textContent).toBe('3.4 / 4 GB');
    expect(card('Load').querySelector('.cur')!.textContent).toBe('0.70');
    expect(screen.getByText('Up')).toBeTruthy();
    expect(screen.getByText('7 h 41 min')).toBeTruthy();
    expect(screen.getByText(/The machine the backend runs on\./)).toBeTruthy();
  });

  it('disk shows used / total and %', async () => {
    fakeApi({ routes: { 'GET /api/metrics': report() } });
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'Disk · vaults' });
    expect(card('Disk · vaults').querySelector('.cur')!.textContent).toBe('8.5 / 20 GB · 43 %');
    expect(card('Disk · config').querySelector('.cur')!.textContent).toBe('0.2 / 1 GB · 20 %');
  });

  it('range switch refetches with ?range=', async () => {
    const fetched: string[] = [];
    fakeApi({ routes: { 'GET /api/metrics': report() } });
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => { if (url.includes('/metrics')) fetched.push(url); return inner(url, init); });
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    expect(fetched.at(-1)).toMatch(/range=24h$/);
    expect(screen.getAllByText('24 h ago')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(fetched.at(-1)).toMatch(/range=7d$/));
  });

  it('polls every 30 s only while the section is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi({ routes: { 'GET /api/metrics': report() } });
    const n = () => api.calls.filter((c) => c.call === 'GET /api/metrics').length;
    const { unmount } = renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    const base = n();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(n()).toBe(base + 1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(n()).toBe(base + 3);
    unmount();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(n()).toBe(base + 3);
  });

  it('skips polls while the page is hidden and refetches when it shows again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi({ routes: { 'GET /api/metrics': report() } });
    const n = () => api.calls.filter((c) => c.call === 'GET /api/metrics').length;
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    const base = n();
    const hidden = (v: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
    try {
      hidden(true);
      await act(() => vi.advanceTimersByTimeAsync(90_000));
      expect(n()).toBe(base);
      hidden(false);
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      await waitFor(() => expect(n()).toBe(base + 1));
    } finally { delete (document as { hidden?: boolean }).hidden; }
  });

  it('polls and words its texts by the report\'s intervalS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = fakeApi({ routes: { 'GET /api/metrics': { ...report(), intervalS: 10 } } });
    const n = () => api.calls.filter((c) => c.call === 'GET /api/metrics').length;
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    expect(screen.getByText(/sampled every 10 s/)).toBeTruthy();
    const base = n();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(n()).toBe(base + 1);
  });

  it('the empty state names the report\'s interval', async () => {
    fakeApi({ routes: { 'GET /api/metrics': { samples: [], latest: null, uptimeS: 0, intervalS: 15 } } });
    renderApp(<ServerSection />);
    expect(await screen.findByText(/the first sample comes within 15 s\./)).toBeTruthy();
  });

  it('"updated N s ago" ticks every second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeApi({ routes: { 'GET /api/metrics': report() } });
    renderApp(<ServerSection />);
    await screen.findByRole('img', { name: 'CPU' });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText(/updated [3-9] s ago/)).toBeTruthy();
  });

  it('opencode down shows a warning', async () => {
    fakeApi({ routes: { 'GET /api/metrics': report({ opencodeUp: false }) } });
    renderApp(<ServerSection />);
    expect(await screen.findByText('Down')).toBeTruthy();
    expect(screen.queryByText('Up')).toBeNull();
  });

  it('no samples yet: says the first one comes within 30 s', async () => {
    fakeApi();
    renderApp(<ServerSection />);
    expect(await screen.findByText(/No data yet — the first sample comes within 30 s\./)).toBeTruthy();
  });
});
