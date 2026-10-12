import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { preparePage } from '../lib/html-page';

/** Vault images bigger than this stay out of a rendered page (their alt text shows). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * An HTML page's Read mode (#126): the page, made inert by `preparePage`, in a sandboxed frame. No
 * `allow-scripts` and no `allow-same-origin`: nothing in it runs, and it can't reach the app's token,
 * storage or DOM. Links may open a new tab or, on a click, move the app to a vault file.
 */
export function HtmlView({ vault, path, text, paths }: { vault: string; path: string; text: string; paths: readonly string[] }) {
  const [doc, setDoc] = useState<string | null>(null);
  // The tree refetches its list on every file event: rebuild (images reloaded, scroll reset) only when it really changed.
  const pathsKey = paths.join('\n');
  const stablePaths = useMemo(() => paths, [pathsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    const load = async (p: string) => {
      try {
        const res = await api.raw(vault, p);
        return { type: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream', bytes: await res.arrayBuffer() };
      } catch { return null; }
    };
    preparePage(text, { vault, path, paths: stablePaths, load, maxBytes: MAX_IMAGE_BYTES })
      .then((d) => { if (live) setDoc(d); }, () => { if (live) setDoc(''); });
    return () => { live = false; };
  }, [vault, path, text, stablePaths]);
  if (doc === null) return <div className="html-view skeleton" aria-busy="true" />;
  if (doc === '') return <div className="html-view">The page can't be shown.</div>;
  return (
    <iframe className="html-view" data-testid="html-view" title={path.split('/').pop()} srcDoc={doc}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" />
  );
}
