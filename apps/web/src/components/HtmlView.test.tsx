// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fake-api';
import { HtmlView } from './HtmlView';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('HtmlView (#126)', () => {
  it('a new file list with the same paths doesn\'t rebuild the page', async () => {
    localStorage.setItem('karpathy.token', 't');
    const api = fakeApi();
    const html = '<html><body><img src="a.png" alt="a"></body></html>';
    const r = render(<HtmlView vault="v" path="p.html" text={html} paths={['a.png', 'p.html']} />);
    await waitFor(() => expect(r.getByTestId('html-view')).toBeTruthy());
    const raws = () => api.calls.filter((c) => c.call === 'GET /api/vaults/v/raw').length;
    expect(raws()).toBe(1);
    r.rerender(<HtmlView vault="v" path="p.html" text={html} paths={['a.png', 'p.html']} />);
    await new Promise((res) => setTimeout(res, 50));
    expect(raws()).toBe(1);
  });
});
