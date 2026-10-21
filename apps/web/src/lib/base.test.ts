// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseResult } from '@karpathy/shared';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ApiError, api } from './api';
import { baseChanged, mountBase, resetBases } from './base';
import { liveMarkdown } from './cm';
import { renderMarkdown } from './markdown';

const result: BaseResult = {
  view: 'Low confidence',
  columns: [{ id: 'file.name', label: 'file name' }, { id: 'confidence', label: 'Confidence' }, { id: 'related', label: 'related' }, { id: 'tags', label: 'tags' }],
  rows: [
    { path: 'wiki/a.md', cells: [{ link: 'wiki/a.md', text: 'a.md' }, 'low', '[[b|Bee]]', ['x', 'y']] },
    { path: 'wiki/b.md', cells: [{ link: 'wiki/b.md', text: 'b.md' }, null, null, []] },
  ],
  total: 2,
  notices: ['groupBy is not supported in v1 and is left out'],
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const ctx = () => ({ vault: 'v1', open: vi.fn(), follow: vi.fn() });

beforeEach(() => resetBases());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('mountBase', () => {
  it('renders the table with headers, link cells, wikilinks, lists, a row count and notices', async () => {
    const spy = vi.spyOn(api, 'base').mockResolvedValue(result);
    const host = document.createElement('div');
    const c = ctx();
    mountBase(host, 'filters: x', c);
    await flush();
    expect(spy).toHaveBeenCalledWith('v1', 'filters: x');
    expect([...host.querySelectorAll('th')].map((t) => t.textContent)).toEqual(['file name', 'Confidence', 'related', 'tags']);
    const rows = host.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('td')!.textContent).toBe('a.md');
    expect(rows[0]!.querySelectorAll('td')[2]!.textContent).toBe('Bee');
    expect(rows[0]!.querySelectorAll('td')[3]!.textContent).toBe('x, y');
    expect(host.querySelector('.base-scroll')).not.toBeNull();
    expect(host.querySelector('.base-foot')!.textContent).toMatch(/2 rows.*groupBy/);
    // A tap on a row opens its note; on a wikilink cell, the link's target.
    (rows[1]!.querySelectorAll('td')[1] as HTMLElement).click();
    expect(c.open).toHaveBeenCalledWith('wiki/b.md');
    (rows[0]!.querySelector('a.wl') as HTMLElement).click();
    expect(c.follow).toHaveBeenCalledWith('b|Bee');
  });

  it('shows the backend message inline when the syntax is not supported (no table, no crash)', async () => {
    vi.spyOn(api, 'base').mockRejectedValue(new ApiError(422, 'The view type `cards` is not supported in v1', 'base-unsupported'));
    const host = document.createElement('div');
    mountBase(host, 'views: [{type: cards}]', ctx());
    await flush();
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('[data-testid="base-error"]')!.textContent).toMatch(/cards.*not supported in v1/);
  });

  it('re-runs when the vault changes, and stops after unmount', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api, 'base').mockResolvedValue(result);
    const host = document.createElement('div');
    const stop = mountBase(host, 'q', ctx());
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockResolvedValue({ ...result, rows: result.rows.slice(0, 1), total: 1 });
    baseChanged('v1');
    baseChanged('other-vault');
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    stop();
    baseChanged('v1');
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a remount of the same block shows the last result at once, without a new request', async () => {
    const spy = vi.spyOn(api, 'base').mockResolvedValue(result);
    mountBase(document.createElement('div'), 'q', ctx())();
    await flush();
    const host = document.createElement('div');
    mountBase(host, 'q', ctx());
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('Read mode', () => {
  it('a ```base block becomes a placeholder carrying its source; raw HTML cannot forge one', () => {
    const html = renderMarkdown('# T\n\n```base\nfilters: file.hasTag("x")\n```\n\n<div class="base-block" data-base="evil"></div>\n', { exists: () => true });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const blocks = doc.querySelectorAll('.base-block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.getAttribute('data-base')).toBe('filters: file.hasTag("x")');
  });
});

describe('Write mode live preview', () => {
  const embeds = { resolve: () => ({ state: 'missing', target: '' }) as never, ctx: () => ({}) as never, epoch: () => 0 };
  const doc = 'Intro\n\n```base\nfilters: x\n```\n\nOutro\n';

  it('shows the table in place of the block while the cursor is outside, the source when it is inside', async () => {
    vi.spyOn(api, 'base').mockResolvedValue(result);
    const view = new EditorView({ doc, extensions: liveMarkdown(() => true, () => {}, embeds, { ctx: ctx }), parent: document.body, selection: EditorSelection.cursor(0) });
    await flush();
    expect(view.dom.querySelector('.cm-base table')).not.toBeNull();
    expect(view.dom.textContent).not.toContain('filters: x');
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('filters')) });
    expect(view.dom.querySelector('.cm-base')).toBeNull();
    expect(view.dom.textContent).toContain('filters: x');
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it('the Edit button puts the cursor into the block', async () => {
    vi.spyOn(api, 'base').mockResolvedValue(result);
    const view = new EditorView({ doc, extensions: liveMarkdown(() => true, () => {}, embeds, { ctx: ctx }), parent: document.body, selection: EditorSelection.cursor(0) });
    await flush();
    (view.dom.querySelector('[data-testid="base-edit"]') as HTMLElement).click();
    expect(view.state.selection.main.head).toBe(doc.indexOf('filters'));
    view.destroy();
  });
});
