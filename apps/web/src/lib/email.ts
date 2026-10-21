// An `.eml` file (#166) parsed for the email view: headers as text, the body, inline images by Content-ID
// and the attachments. postal-mime does the MIME work (charsets, encodings, multipart); this only reduces its
// result to what the view shows.
import PostalMime, { type Address } from 'postal-mime';
import { dataUrl, MAX_IMAGE_BYTES } from './html-page';

export interface Part { type: string; bytes: ArrayBuffer }

export interface ParsedEmail {
  /** '' when the mail has none. */
  subject: string;
  /** `Name <address>`, or the address alone. */
  from?: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  date?: Date;
  html?: string;
  text?: string;
  /** Image parts the HTML body names by `cid:`, keyed by their Content-ID without `<>`. */
  inline: Map<string, Part>;
  attachments: (Part & { name: string })[];
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/html': 'html', 'text/calendar': 'ics', 'message/rfc822': 'eml',
};

function addresses(list: Address[] | undefined): string[] {
  return (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => (m.name ? `${m.name} <${m.address}>` : m.address));
}

/** RFC 2392: a `cid:` URL is percent-encoded; Content-IDs compare without case. */
function cidKey(ref: string): string {
  try { return decodeURIComponent(ref).toLowerCase(); } catch { return ref.toLowerCase(); }
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  const b = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Throws when the bytes hold no mail (no subject, no From, no body): postal-mime itself accepts anything. */
export async function parseEmail(raw: ArrayBuffer | Uint8Array): Promise<ParsedEmail> {
  // A forwarded mail stays a part of its own (an attachment), not a piece of the body.
  const m = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', rfc822Attachments: true });
  if (!m.subject && !m.from && !m.html && !m.text) throw new Error('not an email');
  // A part is inline only when the body really names it: mail clients mark inline images as attachments and the
  // other way round.
  // Only a `src` the view replaces counts; an image named elsewhere (CSS) or too big to inline stays an attachment.
  const named = new Set([...(m.html ?? '').matchAll(/\bsrc\s*=\s*["']?cid:([^"'\s>]+)/gi)].map((x) => cidKey(x[1]!)));
  const inline = new Map<string, Part>();
  const attachments: ParsedEmail['attachments'] = [];
  let n = 0;
  for (const a of m.attachments) {
    const cid = a.contentId && cidKey(a.contentId.replace(/^<|>$/g, ''));
    const part = { type: a.mimeType, bytes: bytesOf(a.content) };
    if (cid && named.has(cid) && a.mimeType.startsWith('image/') && part.bytes.byteLength <= MAX_IMAGE_BYTES) inline.set(cid, part);
    else {
      n++;
      const ext = EXT[a.mimeType];
      attachments.push({ ...part, name: a.filename || `attachment-${n}${ext ? `.${ext}` : ''}` });
    }
  }
  const date = m.date ? new Date(m.date) : undefined;
  return {
    subject: m.subject ?? '',
    from: addresses(m.from ? [m.from] : undefined)[0],
    to: addresses(m.to),
    cc: addresses(m.cc),
    replyTo: addresses(m.replyTo),
    date: date && !isNaN(date.getTime()) ? date : undefined,
    html: m.html,
    text: m.text,
    inline,
    attachments,
  };
}

/** The HTML body with its inline images as `data:` URLs (`preparePage` would turn a `cid:` image into a link); an
 * unknown `cid:` image keeps only its alt text. */
export function bodyHtml(mail: ParsedEmail): string {
  const doc = new DOMParser().parseFromString(mail.html ?? '', 'text/html');
  for (const img of doc.querySelectorAll('[src]')) {
    const src = img.getAttribute('src')!;
    if (!/^cid:/i.test(src)) continue;
    const part = mail.inline.get(cidKey(src.slice(4)));
    if (part) img.setAttribute('src', dataUrl(part.type, part.bytes));
    else img.removeAttribute('src');
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
