import type { FileEntry, VaultStatus } from '@karpathy/shared';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { AppProvider } from '../store';

/**
 * Component tests run the real store (AppProvider) against a fake backend at the HTTP boundary: `fetch`
 * answers the few routes the store loads on mount, plus whatever a test adds in `routes`.
 */

export const VAULT = 'v1';

export const statusOf = (s: Partial<VaultStatus> = {}): VaultStatus => ({
  state: 'ready', changedCount: 0, inputChangedCount: 0, unpushedCount: 0, incomingCount: 0, incomingPaths: [], busy: 'none', conflictPaths: [], ...s,
});

type Answer = unknown | ((body: unknown) => unknown);
export interface FakeApi {
  /** Every request the app made, in order: `METHOD /api/path`, with its JSON body. */
  calls: { call: string; body: unknown }[];
}

export function fakeApi(opts: { files?: FileEntry[]; status?: Partial<VaultStatus>; routes?: Record<string, Answer> } = {}): FakeApi {
  const routes: Record<string, Answer> = {
    'GET /api/vaults': [{ id: VAULT, repo: 'o/r', branch: 'main', state: 'ready' }],
    'GET /api/settings': { commitReminderThreshold: 20, model: 'x/y', webAccess: false, githubToken: { source: 'none', last4: null }, modelInput: null },
    [`POST /api/vaults/${VAULT}/open`]: statusOf(opts.status),
    [`GET /api/vaults/${VAULT}/files`]: opts.files ?? [],
    [`GET /api/vaults/${VAULT}/commands`]: [],
    [`GET /api/vaults/${VAULT}/chats`]: [],
    ...opts.routes,
  };
  const api: FakeApi = { calls: [] };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.split('?')[0]!;
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    api.calls.push({ call: key, body });
    // Event streams stay open and silent.
    if (path.endsWith('/events') || path.endsWith('/stream')) return new Response(new ReadableStream());
    if (!(key in routes)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const a = routes[key];
    const out = typeof a === 'function' ? (a as (b: unknown) => unknown)(body) : a;
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  });
  return api;
}

/** jsdom lacks matchMedia; `phone` picks the phone layout's media queries. */
export function setViewport(phone: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: phone ? q.includes('max-width: 699px') : q.includes('min-width: 1024px'),
    media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
}

export function renderApp(ui: ReactNode): RenderResult {
  localStorage.setItem('karpathy.token', 't');
  return render(<AppProvider>{ui}</AppProvider>);
}
