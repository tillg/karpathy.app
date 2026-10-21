// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphData } from '@karpathy/shared';
import { api } from '../lib/api';

// The 3D graph needs WebGL: a stand-in whose every method chains.
const calls = vi.hoisted(() => [] as string[]);
vi.mock('3d-force-graph', () => ({
  default: function ForceGraph3D() {
    const g: object = new Proxy({}, {
      get: (_t, k) => (k === 'then' ? undefined : k === 'controls' ? () => ({ mouseButtons: {}, touches: {} }) : (...args: unknown[]) => {
        // A getter call (no arguments) answers; a setter chains and is recorded.
        if (k === 'graphData' && !args.length) return { nodes: [], links: [] };
        calls.push(String(k));
        return g;
      }),
    });
    return g;
  },
}));
vi.mock('three', () => ({ MOUSE: {}, TOUCH: {} }));

const app = {
  activeId: 'v1', note: { path: 'Wiki/a.md' } as { path: string } | null, openNote: vi.fn(), graphOpen: true, setGraphOpen: vi.fn(),
  graphScope: 'local', setGraphScope: vi.fn(), phone: false, admin: null,
};
vi.mock('../store', () => ({ useApp: () => app }));

const { GraphPane } = await import('./GraphPane');

const g1: GraphData = { nodes: [{ path: 'Wiki/a.md' }, { path: 'Wiki/b.md' }], links: [{ source: 'Wiki/a.md', target: 'Wiki/b.md' }] };
const g2: GraphData = { nodes: [...g1.nodes, { path: 'Wiki/new.md' }], links: [...g1.links, { source: 'Wiki/new.md', target: 'Wiki/a.md' }] };
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GraphPane local graph (#92)', () => {
  it('a note made after the graph was read: the graph is read again and the note is the centre', async () => {
    const spy = vi.spyOn(api, 'graph').mockResolvedValueOnce(g1).mockResolvedValue(g2);
    app.note = { path: 'Wiki/a.md' };
    const { rerender } = render(<GraphPane />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('graph-local').getAttribute('aria-pressed')).toBe('true');
    // The AI writes Wiki/new.md; the user opens it.
    app.note = { path: 'Wiki/new.md' };
    rerender(<GraphPane />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('graph-local').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('graph').dataset.nodes).toBe('2');
    expect(screen.getByText(/within 1 link of new/)).toBeTruthy();
    // Opening it again doesn't read the graph again.
    app.note = { path: 'Wiki/b.md' };
    rerender(<GraphPane />);
    app.note = { path: 'Wiki/new.md' };
    rerender(<GraphPane />);
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('in the Wiki view a note switch keeps the layout (no new graph data); the local graph follows the note', async () => {
    vi.spyOn(api, 'graph').mockResolvedValue(g2);
    app.note = { path: 'Wiki/a.md' };
    app.graphScope = 'wiki';
    const { rerender } = render(<GraphPane />);
    await flush();
    const handed = () => calls.filter((c) => c === 'graphData').length;
    const before = handed();
    expect(before).toBeGreaterThan(0);
    app.note = { path: 'Wiki/b.md' };
    rerender(<GraphPane />);
    await flush();
    expect(handed()).toBe(before);
    app.graphScope = 'local';
    rerender(<GraphPane />);
    await flush();
    app.note = { path: 'Wiki/a.md' };
    rerender(<GraphPane />);
    await flush();
    expect(handed()).toBe(before + 2);
  });

  it('a page that is no note (not Markdown) is not a reason to read the graph again', async () => {
    const spy = vi.spyOn(api, 'graph').mockResolvedValue(g1);
    app.note = { path: 'Wiki/a.md' };
    const { rerender } = render(<GraphPane />);
    await flush();
    const before = spy.mock.calls.length;
    app.note = { path: 'pages/x.html' };
    rerender(<GraphPane />);
    await flush();
    expect(spy.mock.calls.length).toBe(before);
  });
});
