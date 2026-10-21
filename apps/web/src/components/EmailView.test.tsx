// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi } from '../test/fake-api';
import { EmailView } from './EmailView';

// Synthetic mails (no real ones), read as bytes so latin1.eml stays non-UTF-8.
// jsdom's import.meta.url is no file URL.
const bytes = (name: string) => readFileSync(join(__dirname, '../lib/fixtures', name));
const text = (name: string) => bytes(name).toString('utf8');
const RAW = 'GET /api/vaults/v/raw';
const HEAD = 'HEAD /api/vaults/v/raw';

beforeEach(() => {
  localStorage.setItem('karpathy.token', 't');
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:att-${++n}`, revokeObjectURL: () => {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('EmailView (#166)', () => {
  it('related: file name while parsing, then subject, header block, inert body with the cid image, one attachment', async () => {
    const api = fakeApi();
    const r = render(<EmailView vault="v" path="Mail/related.eml" text={text('related.eml')} binary={false} />);
    expect(r.container.querySelector('.note-title')!.textContent).toBe('related.eml');
    await waitFor(() => expect(r.container.querySelector('.note-title')!.textContent).toBe('Report with a picture'));
    // .note-title is visually hidden app-wide: the subject also shows on screen.
    expect(r.getByTestId('email-subject').textContent).toBe('Report with a picture');
    const head = r.getByTestId('email-head').textContent!;
    expect(head).toContain('Grace Hopper <grace@example.org>');
    expect(head).toContain('ada@example.org');
    expect(head).toContain('noreply@example.org');
    expect(head).not.toContain('Cc');
    const frame = await r.findByTestId('email-body');
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin/);
    const doc = frame.getAttribute('srcdoc')!;
    expect(doc).toContain('src="data:image/png;base64,');
    expect(doc).not.toContain('cid:');
    expect(doc).toMatch(/<a [^>]*href="https:\/\/example\.com\/track\.png"/);
    const atts = r.getAllByTestId('email-attachment');
    expect(atts.map((a) => [a.getAttribute('download'), a.getAttribute('href')])).toEqual([['report.pdf', 'blob:att-1']]);
    expect(atts[0]!.textContent).toContain('588 B');
    expect(api.calls.filter((c) => c.call === RAW || c.call === HEAD)).toEqual([]);
  });

  it('a binary mail is fetched via HEAD and GET /raw and decodes', async () => {
    const latin1 = bytes('latin1.eml');
    const api = fakeApi({ routes: {
      [HEAD]: () => new Response(null, { headers: { 'content-length': String(latin1.length) } }),
      [RAW]: () => new Response(latin1),
    } });
    const r = render(<EmailView vault="v" path="latin1.eml" text="" binary />);
    await waitFor(() => expect(r.container.querySelector('.note-title')!.textContent).toBe('Grüße aus Köln'));
    expect(r.getByTestId('email-head').textContent).toContain('Jürgen Müller <juergen@example.org>');
    expect(r.getByTestId('email-text').textContent).toBe('Grüße aus Köln.\nDas Wetter ist schön.\n');
    expect(api.calls.map((c) => c.call).filter((c) => c === RAW || c === HEAD)).toEqual([HEAD, RAW]);
  });

  it('a binary mail over the preview limit asks first', async () => {
    const api = fakeApi({ routes: { [HEAD]: () => new Response(null, { headers: { 'content-length': String(60 * 1024 * 1024) } }) } });
    const r = render(<EmailView vault="v" path="big.eml" text="" binary />);
    expect(await r.findByTestId('file-load')).toBeTruthy();
    expect(api.calls.some((c) => c.call === RAW)).toBe(false);
  });

  it('plain: the text body keeps its line breaks, no frame', async () => {
    fakeApi();
    const r = render(<EmailView vault="v" path="plain.eml" text={text('plain.eml')} binary={false} />);
    expect((await r.findByTestId('email-text')).textContent).toBe('Line one\nLine two\n\nAfter a blank line.\n');
    expect(r.queryByTestId('email-body')).toBeNull();
    expect(r.queryByTestId('email-attachment')).toBeNull();
  });

  it('bytes that are no mail: "This email can\'t be shown."', async () => {
    fakeApi();
    const r = render(<EmailView vault="v" path="x.eml" text={'\u0000garbage'} binary={false} />);
    expect(await r.findByText('This email can’t be shown.')).toBeTruthy();
    expect(r.container.querySelector('.note-title')!.textContent).toBe('x.eml');
  });
});
