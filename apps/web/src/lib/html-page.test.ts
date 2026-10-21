// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { preparePage, type PageCtx } from './html-page';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const files: Record<string, { type: string; bytes: ArrayBuffer }> = {
  'Reports/style.css': { type: 'text/css', bytes: enc('h1 { color: red; }') },
  'Reports/img/dot.png': { type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]).buffer },
  'secret.png': { type: 'image/png', bytes: new Uint8Array([1]).buffer },
};

function ctx(over: Partial<PageCtx> = {}): PageCtx & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    vault: 'v',
    path: 'Reports/page.html',
    paths: [...Object.keys(files), 'Reports/page.html', 'Home.md'],
    load: async (p) => { loaded.push(p); return files[p] ?? null; },
    maxBytes: 10 * 1024 * 1024,
    loaded,
    ...over,
  };
}

const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('preparePage (#126)', () => {
  it('removes scripts, handlers, javascript: links, forms, frames and base', async () => {
    const out = doc(await preparePage(`<html><head><base href="https://x/"><script>alert(1)</script></head><body>
      <a href="javascript:alert(1)">j</a><p onclick="alert(1)">p</p><form><input></form><iframe src="https://x"></iframe></body></html>`, ctx()));
    expect(out.querySelector('script, form, iframe, base')).toBeNull();
    expect(out.querySelector('[onclick]')).toBeNull();
    expect(out.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/javascript:/);
  });

  it('keeps <style> and style=', async () => {
    const out = doc(await preparePage('<html><head><style>p { color: blue }</style></head><body><p style="margin: 3px">x</p></body></html>', ctx()));
    expect(out.querySelector('style')?.textContent).toContain('color: blue');
    expect(out.querySelector('p')?.getAttribute('style')).toBe('margin: 3px');
  });

  it('a vault stylesheet becomes <style> with its text; a remote one is removed', async () => {
    const out = doc(await preparePage('<html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn/x.css"></head><body></body></html>', ctx()));
    expect(out.querySelector('link')).toBeNull();
    expect([...out.querySelectorAll('style')].map((s) => s.textContent)).toEqual(['h1 { color: red; }']);
  });

  it('a vault image becomes a data: URL; one over the size cap keeps only its alt', async () => {
    const out = doc(await preparePage('<html><body><img src="img/dot.png" alt="dot"></body></html>', ctx()));
    expect(out.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
    const big = doc(await preparePage('<html><body><img src="img/dot.png" alt="dot"></body></html>', ctx({ maxBytes: 2 })));
    expect(big.querySelector('img')).toBeNull();
    expect(big.body.textContent).toContain('dot');
  });

  it('a remote image becomes a link', async () => {
    const out = doc(await preparePage('<html><body><img src="https://example.com/a.png" alt="A"></body></html>', ctx()));
    expect(out.querySelector('img')).toBeNull();
    const a = out.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/a.png');
    expect(a?.textContent).toBe('A');
  });

  it('links: a vault file → the app route in the top window; external → new tab; #anchor stays', async () => {
    const out = doc(await preparePage('<html><body><a href="../Home.md">h</a><a href="https://example.com">e</a><a href="#s">s</a></body></html>', ctx()));
    const [vaultLink, ext, anchor] = [...out.querySelectorAll('a')];
    expect(vaultLink!.getAttribute('href')).toBe('/#/v/Home.md');
    expect(vaultLink!.getAttribute('target')).toBe('_top');
    expect(ext!.getAttribute('target')).toBe('_blank');
    expect(ext!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor!.getAttribute('href')).toBe('#s');
    expect(anchor!.getAttribute('target')).toBeNull();
  });

  it('no link can move the app by itself: image-map areas are rewritten like links, a #anchor loses its target (#166)', async () => {
    const out = doc(await preparePage('<html><body><map name="m"><area href="https://evil.example/" target="_top"></map>'
      + '<a href="#/v/Other.md" target="_top">x</a></body></html>', ctx()));
    const area = out.querySelector('area')!;
    expect(area.getAttribute('target')).toBe('_blank');
    expect(area.getAttribute('rel')).toBe('noopener noreferrer');
    expect(out.querySelector('a')!.getAttribute('target')).toBeNull();
  });

  it('a path that leaves the vault is never loaded', async () => {
    const c = ctx();
    await preparePage('<html><body><img src="../../secret.png"></body></html>', c);
    expect(c.loaded).toEqual([]);
  });

  it('a reference with a stray % counts as missing instead of failing the page', async () => {
    const out = doc(await preparePage('<html><body><img src="100%.png" alt="pct"><a href="50%off.html">x</a></body></html>', ctx()));
    expect(out.querySelector('img')).toBeNull();
    expect(out.body.textContent).toContain('pct');
    expect(out.querySelector('a')?.hasAttribute('href')).toBe(false);
  });
});
