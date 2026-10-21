import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { ParsedEmail } from '../lib/email';
import { human } from '../lib/embed';
import { dataUrl, preparePage } from '../lib/html-page';
import { fileSize, MAX_PREVIEW_BYTES } from '../lib/media';

/** Inline images bigger than this stay out of the body (their alt text shows), as in HTML pages. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type State =
  | { s: 'loading' }
  | { s: 'large'; size: number }
  | { s: 'error' }
  | { s: 'ok'; mail: ParsedEmail; doc?: string };

/** The HTML body, made inert like an HTML page: `cid:` images become `data:` URLs first (`preparePage` would link them). */
async function bodyDoc(mail: ParsedEmail, vault: string, path: string): Promise<string> {
  const html = mail.html!.replace(/\b(src|background)\s*=\s*(["']?)cid:([^"'\s>]+)\2/gi, (_, attr: string, _q, id: string) => {
    const part = mail.inline.get(id);
    return `${attr}="${part && part.bytes.byteLength <= MAX_IMAGE_BYTES ? dataUrl(part.type, part.bytes) : ''}"`;
  });
  // A mail has no vault context: relative references resolve to nothing.
  return preparePage(html, { vault, path, paths: [], load: async () => null, maxBytes: MAX_IMAGE_BYTES });
}

/**
 * An `.eml` file (#166), read-only: subject, header block, the body (HTML in the sandboxed frame HTML pages use,
 * else the text) and the attachments as downloads. A UTF-8 mail is parsed from the text `GET /file` already
 * brought; only a binary one (Latin-1, 8-bit parts) is fetched again from `GET /raw`.
 */
export function EmailView({ vault, path, text, binary }: { vault: string; path: string; text: string; binary: boolean }) {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [force, setForce] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      let bytes: ArrayBuffer | Uint8Array;
      if (binary) {
        const size = force ? null : await fileSize(vault, path);
        if (size !== null && size > MAX_PREVIEW_BYTES) { if (live) setState({ s: 'large', size }); return; }
        bytes = await (await api.raw(vault, path)).arrayBuffer();
      } else bytes = new TextEncoder().encode(text);
      // The parser stays out of the main bundle.
      const { parseEmail } = await import('../lib/email');
      const mail = await parseEmail(bytes);
      const doc = mail.html ? await bodyDoc(mail, vault, path) : undefined;
      if (live) setState({ s: 'ok', mail, doc });
    })().catch(() => { if (live) setState({ s: 'error' }); });
    return () => { live = false; };
  }, [vault, path, text, binary, force]);

  const mail = state.s === 'ok' ? state.mail : null;
  const atts = useMemo(() => (mail?.attachments ?? []).map((a) => ({ ...a, url: URL.createObjectURL(new Blob([a.bytes], { type: a.type })) })), [mail]);
  useEffect(() => () => { for (const a of atts) URL.revokeObjectURL(a.url); }, [atts]);

  const name = path.split('/').pop()!;
  const rows: [string, string][] = mail
    ? ([['From', mail.from ?? ''], ['To', mail.to.join(', ')], ['Cc', mail.cc.join(', ')], ['Reply-To', mail.replyTo.join(', ')],
        ['Date', mail.date?.toLocaleString() ?? '']] as [string, string][]).filter(([, v]) => v)
    : [];
  return (
    <div className="doc email-view">
      <h2 className="note-title">{mail?.subject || name}</h2>
      {state.s === 'loading' && <div className="html-view skeleton" aria-busy="true" />}
      {state.s === 'error' && <div className="placeholder" data-testid="email-error"><p>This email can’t be shown.</p></div>}
      {state.s === 'large' && (
        <div className="file-card">
          <span className="fc-name">{name}</span><span className="fc-meta">{human(state.size)}</span>
          <span className="fc-acts"><button className="link" data-testid="file-load" onClick={() => setForce(true)}>Load anyway ({human(state.size)})</button></span>
        </div>
      )}
      {mail && (
        <>
          {/* `.note-title` is only for screen readers (the breadcrumb shows the path): the subject is shown here. */}
          {mail.subject && <div className="email-subject" data-testid="email-subject" aria-hidden="true">{mail.subject}</div>}
          <dl className="email-head" data-testid="email-head">
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          {atts.length > 0 && (
            <div className="email-atts">
              {atts.map((a) => (
                <a key={a.url} className="file-card" data-testid="email-attachment" href={a.url} download={a.name}>
                  <span className="fc-name">{a.name}</span><span className="fc-meta">{human(a.bytes.byteLength)}</span>
                </a>
              ))}
            </div>
          )}
          {state.s === 'ok' && state.doc !== undefined
            ? <iframe className="html-view" data-testid="email-body" title={mail.subject || name} srcDoc={state.doc}
                sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" />
            : <div className="email-text" data-testid="email-text">{mail.text ?? ''}</div>}
        </>
      )}
    </div>
  );
}
