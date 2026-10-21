import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Part, ParsedEmail } from '../lib/email';
import { human } from '../lib/embed';
import { MAX_IMAGE_BYTES, preparePage, SANDBOX } from '../lib/html-page';
import { fileSize, MAX_PREVIEW_BYTES } from '../lib/media';

type State =
  | { s: 'loading' }
  | { s: 'large'; size: number }
  | { s: 'error' }
  | { s: 'ok'; mail: ParsedEmail; doc?: string };

/** Saves an attachment. As `application/octet-stream`, so the browser never opens an HTML or SVG one as a page of the app. */
function download(a: Part & { name: string }) {
  const url = URL.createObjectURL(new Blob([a.bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = a.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      // A huge mail would freeze the tab while parsing, whichever way its bytes came.
      if (!binary && !force && text.length > MAX_PREVIEW_BYTES) { if (live) setState({ s: 'large', size: text.length }); return; }
      if (binary) {
        const size = force ? null : await fileSize(vault, path);
        if (size !== null && size > MAX_PREVIEW_BYTES) { if (live) setState({ s: 'large', size }); return; }
        bytes = await (await api.raw(vault, path)).arrayBuffer();
      } else bytes = new TextEncoder().encode(text);
      // The parser stays out of the main bundle.
      const { bodyHtml, parseEmail } = await import('../lib/email');
      const mail = await parseEmail(bytes);
      // Inert like an HTML page; a mail has no vault context, so relative references resolve to nothing.
      const doc = mail.html
        ? await preparePage(bodyHtml(mail), { vault, path, paths: [], load: async () => null, maxBytes: MAX_IMAGE_BYTES })
        : undefined;
      if (live) setState({ s: 'ok', mail, doc });
    })().catch(() => { if (live) setState({ s: 'error' }); });
    return () => { live = false; };
  }, [vault, path, text, binary, force]);

  const mail = state.s === 'ok' ? state.mail : null;

  const name = path.split('/').pop()!;
  const rows: [string, string][] = mail
    ? ([['From', mail.from ?? ''], ['To', mail.to.join(', ')], ['Cc', mail.cc.join(', ')], ['Reply-To', mail.replyTo.join(', ')],
        ['Date', mail.date?.toLocaleString() ?? '']] as [string, string][]).filter(([, v]) => v)
    : [];
  return (
    <div className="doc email-view">
      <h2 className="note-title">{mail?.subject || name}</h2>
      {state.s === 'loading' && <div className="html-view skeleton" aria-busy="true" />}
      {state.s === 'error' && <div className="placeholder" data-testid="email-error"><p><b>{name}</b><br />This email can’t be shown.</p></div>}
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
          {mail.attachments.length > 0 && (
            <div className="email-atts">
              {mail.attachments.map((a, i) => (
                <button key={i} className="file-card" data-testid="email-attachment" title={`Download ${a.name}`} onClick={() => download(a)}>
                  <span className="fc-name">{a.name}</span><span className="fc-meta">{human(a.bytes.byteLength)}</span>
                </button>
              ))}
            </div>
          )}
          {state.s === 'ok' && state.doc !== undefined
            ? <iframe className="html-view" data-testid="email-body" title={mail.subject || name} srcDoc={state.doc}
                sandbox={SANDBOX} />
            : <div className="email-text" data-testid="email-text">{mail.text ?? ''}</div>}
        </>
      )}
    </div>
  );
}
