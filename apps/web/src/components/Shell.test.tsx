// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { Shell } from './Shell';

beforeEach(() => setViewport(true));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('phone tab bar', () => {
  it('Files tab shows the input count', async () => {
    fakeApi({ files: [{ path: 'Input/mail-a/index.md', type: 'file' }, { path: 'Input/web-b/index.md', type: 'file' }] });
    renderApp(<Shell />);
    const badge = await screen.findByTestId('input-badge-tab');
    expect(badge.textContent).toBe('2');
    expect(screen.getByTestId('tab-files').contains(badge)).toBe(true);
  });
});
