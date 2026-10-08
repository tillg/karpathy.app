// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '@karpathy/shared';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { FileTree } from './FileTree';

const queue: FileEntry[] = [
  { path: 'Input', type: 'dir' },
  { path: 'Input/mail-2026-10-08-a', type: 'dir' },
  { path: 'Input/mail-2026-10-08-a/index.md', type: 'file', modified: 1 },
  { path: 'Input/insta-2026-10-08-b', type: 'dir' },
  { path: 'Input/web-2026-10-08-c', type: 'dir' },
  { path: 'Input/loose.md', type: 'file', modified: 1 },
  { path: 'Wiki', type: 'dir' },
  { path: 'Wiki/a.md', type: 'file', modified: 1, ai: 1 },
];
const inputRow = async () => screen.findByText('Input', { selector: '.nm' }).then((n) => n.closest('button')!);

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Input badge', () => {
  it('Input row shows a badge with the item count, none at 0', async () => {
    fakeApi({ files: queue });
    renderApp(<FileTree />);
    const row = await inputRow();
    const badge = await within(row).findByTestId('input-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe('3 sources waiting to be ingested');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    cleanup();

    fakeApi({ files: [{ path: 'Input', type: 'dir' }, { path: 'Input/loose.md', type: 'file' }] });
    renderApp(<FileTree />);
    expect(within(await inputRow()).queryByTestId('input-badge')).toBeNull();
  });

  it('stays visible under an active filter', async () => {
    localStorage.setItem('karpathy.treeFilter', 'ai');
    fakeApi({ files: queue });
    renderApp(<FileTree />);
    expect((await within(await inputRow()).findByTestId('input-badge')).textContent).toBe('3');
  });
});

describe('Ingest button', () => {
  const withSkill = { [`GET /api/vaults/v1/commands`]: [{ name: 'ingest', description: 'Ingest', source: 'vault' }] };
  const button = async () => screen.findByTestId('ingest-now');

  it('Ingest button only with an ingest command, disabled offline / in conflict / while a turn runs', async () => {
    fakeApi({ files: queue });
    renderApp(<FileTree />);
    const badge = await within(await inputRow()).findByTestId('input-badge');
    expect(screen.queryByTestId('ingest-now')).toBeNull();
    expect(badge.getAttribute('title')).toMatch(/Add an `ingest` skill to `\.agents\/skills\/`/);
    cleanup();

    fakeApi({ files: queue, routes: withSkill });
    renderApp(<FileTree />);
    expect((await button() as HTMLButtonElement).disabled).toBe(false);
    expect((await button()).parentElement!.querySelector('[data-path="Input"]')).not.toBeNull();
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { dispatchEvent(new Event('offline')); });
    expect((await button() as HTMLButtonElement).disabled).toBe(true);
    expect((await button()).getAttribute('title')).toMatch(/offline/i);
    offline.mockRestore();
    cleanup();

    fakeApi({ files: queue, routes: withSkill, status: { busy: 'turn' } });
    renderApp(<FileTree />);
    await waitFor(async () => expect((await button() as HTMLButtonElement).disabled).toBe(true));
    expect((await button()).getAttribute('title')).toMatch(/AI is working/i);
    cleanup();

    fakeApi({ files: queue, routes: { ...withSkill, 'GET /api/vaults': [{ id: 'v1', repo: 'o/r', branch: 'main', state: 'conflict' }] }, status: { state: 'conflict' } });
    renderApp(<FileTree />);
    await waitFor(async () => expect((await button() as HTMLButtonElement).disabled).toBe(true));
    expect((await button()).getAttribute('title')).toMatch(/conflict/i);
  });
});
