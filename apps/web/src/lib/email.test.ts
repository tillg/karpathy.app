import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEmail } from './email';

// Synthetic mails (no real ones), read as bytes so latin1.eml stays non-UTF-8.
const fixture = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** A multipart/related mail: the HTML body and one base64 part with the given headers. */
const mime = (html: string, part: string[], b64 = 'iVBORw0KGgo=') => new TextEncoder().encode(['From: a@example.org', 'Subject: s',
  'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary=b', '', '--b', 'Content-Type: text/html', '', html,
  '--b', ...part, 'Content-Transfer-Encoding: base64', '', b64, '--b--', ''].join('\r\n'));

describe('parseEmail (#166)', () => {
  it('alternative: subject, addresses, date, html and text', async () => {
    const e = await parseEmail(fixture('alternative.eml'));
    expect(e.subject).toBe('Notes on the Analytical Engine');
    expect(e.from).toBe('Ada Lovelace <ada@example.org>');
    expect(e.to).toEqual(['Charles Babbage <charles@example.org>', 'team@example.org']);
    expect(e.cc).toEqual(['Mary Somerville <mary@example.org>']);
    expect(e.replyTo).toEqual([]);
    expect(e.date?.toISOString()).toBe('2026-10-20T07:30:00.000Z');
    expect(e.html).toContain('<b>notes</b>');
    expect(e.text).toContain('Dear Charles,');
    expect(e.attachments).toEqual([]);
  });

  it('related: the cid image is inline, the PDF is the only attachment', async () => {
    const e = await parseEmail(fixture('related.eml'));
    expect(e.replyTo).toEqual(['noreply@example.org']);
    expect([...e.inline.keys()]).toEqual(['dot@example.org']);
    expect(e.inline.get('dot@example.org')!.type).toBe('image/png');
    expect(e.inline.get('dot@example.org')!.bytes.byteLength).toBe(66);
    expect(e.attachments.map((a) => [a.name, a.type, a.bytes.byteLength])).toEqual([['report.pdf', 'application/pdf', 588]]);
  });

  it('an image part the html doesn\'t name is an attachment, a nameless part gets a name', async () => {
    const raw = ['From: a@example.org', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '',
      '--b', 'Content-Type: text/html', '', '<p>no image</p>',
      '--b', 'Content-Type: image/png', 'Content-ID: <x@y>', 'Content-Transfer-Encoding: base64', '', 'iVBORw0KGgo=',
      '--b', 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=',
      '--b--', ''].join('\r\n');
    const e = await parseEmail(new TextEncoder().encode(raw).buffer);
    expect(e.inline.size).toBe(0);
    expect(e.attachments.map((a) => a.name)).toEqual(['attachment-1.png', 'attachment-2.pdf']);
  });

  it('a cid reference matches its Content-ID decoded and in any case', async () => {
    const e = await parseEmail(mime('<p><img src="cid:Part1%40Host" alt="p"></p>', ['Content-Type: image/png', 'Content-ID: <part1@host>']));
    expect([...e.inline.keys()]).toEqual(['part1@host']);
    expect(e.attachments).toEqual([]);
  });

  it('an image named only in CSS, or over 10 MB, is an attachment: nothing goes missing', async () => {
    const css = await parseEmail(mime('<div style="background: url(cid:bg@x)">x</div>', ['Content-Type: image/png', 'Content-ID: <bg@x>']));
    expect(css.inline.size).toBe(0);
    expect(css.attachments).toHaveLength(1);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    const huge = await parseEmail(mime('<img src="cid:big@x">', ['Content-Type: image/png', 'Content-ID: <big@x>'], big));
    expect(huge.inline.size).toBe(0);
    expect(huge.attachments.map((a) => a.bytes.byteLength)).toEqual([10 * 1024 * 1024 + 1]);
  });

  it('a forwarded mail is an attachment, not part of the body', async () => {
    const raw = ['From: a@example.org', 'Subject: fwd', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=b', '',
      '--b', 'Content-Type: text/plain', '', 'see below',
      '--b', 'Content-Type: message/rfc822', '', 'From: z@example.org', 'Subject: inner', '', 'inner body',
      '--b--', ''].join('\r\n');
    const e = await parseEmail(new TextEncoder().encode(raw));
    expect(e.text).toBe('see below');
    expect(e.attachments.map((a) => [a.name, a.type])).toEqual([['attachment-1.eml', 'message/rfc822']]);
  });

  it('plain: text only, no html', async () => {
    const e = await parseEmail(fixture('plain.eml'));
    expect(e.from).toBe('alan@example.org');
    expect(e.html).toBeUndefined();
    expect(e.text).toBe('Line one\nLine two\n\nAfter a blank line.\n');
  });

  it('latin1: an encoded subject and an ISO-8859-1 body decode', async () => {
    const bytes = fixture('latin1.eml');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
    const e = await parseEmail(bytes);
    expect(e.subject).toBe('Grüße aus Köln');
    expect(e.from).toBe('Jürgen Müller <juergen@example.org>');
    expect(e.text).toBe('Grüße aus Köln.\nDas Wetter ist schön.\n');
  });

  it('bytes that are no mail are refused', async () => {
    await expect(parseEmail(new Uint8Array([0, 1, 2, 255, 254, 13, 10]).buffer)).rejects.toThrow();
    await expect(parseEmail(new ArrayBuffer(0))).rejects.toThrow();
  });

  it('no date or a broken one → undefined', async () => {
    const e = await parseEmail(new TextEncoder().encode('From: a@example.org\r\nDate: someday\r\n\r\nhi\r\n').buffer);
    expect(e.date).toBeUndefined();
    expect(e.text).toBe('hi\n');
  });
});
