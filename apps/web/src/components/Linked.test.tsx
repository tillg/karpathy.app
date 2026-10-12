// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, renderApp, setViewport } from '../test/fake-api';
import { isHttpUrl, Linked } from './Linked';
import { PropertiesPanel } from './PropertiesPanel';

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Linked › URLs (#147)', () => {
  it('a bare http(s) URL is an external link in a new tab; text around it stays', () => {
    fakeApi();
    const { container } = renderApp(<Linked text="see https://www.youtube.com/watch?v=abc123&t=5, ok" />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://www.youtube.com/watch?v=abc123&t=5');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toBe('see https://www.youtube.com/watch?v=abc123&t=5, ok');
  });

  it('a wikilink next to a URL still links in-app', () => {
    fakeApi();
    const { container } = renderApp(<Linked text="[[Foo|bar]] http://a.example/x" />);
    const [wl, url] = [...container.querySelectorAll('a')];
    expect(wl!.className).toContain('wl');
    expect(wl!.textContent).toBe('bar');
    expect(wl!.getAttribute('target')).toBeNull();
    expect(url!.getAttribute('href')).toBe('http://a.example/x');
  });

  it('keeps a closing bracket that matches an opening one in the URL, cuts a stray one', () => {
    fakeApi();
    const wiki = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(isHttpUrl(wiki)).toBe(true);
    const { container } = renderApp(<Linked text={`see ${wiki}, and (https://a.example/x) ok`} />);
    const [a, b] = [...container.querySelectorAll('a')];
    expect(a!.getAttribute('href')).toBe(wiki);
    expect(b!.getAttribute('href')).toBe('https://a.example/x');
  });

  it('text without a URL renders no external link', () => {
    fakeApi();
    const { container } = renderApp(<Linked text="ftp://x.example and example.com" />);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('PropertiesPanel › "open ↗" (#147)', () => {
  const panel = (value: string) => (
    <PropertiesPanel fm={{ props: [{ key: 'trailer', kind: 'text', value } as never], error: null } as never} rules={{}} names={[]} violations={[]}
      view="open" disabled={false} onView={() => {}} onEdit={() => {}} onYaml={() => {}} toast={() => {}} />
  );

  it('a URL value gets an open link next to the editable input', () => {
    fakeApi();
    renderApp(panel('https://example.com/t'));
    const a = screen.getByTestId('props-open') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/t');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('open ↗');
    expect((screen.getByLabelText('trailer') as HTMLInputElement).disabled).toBe(false);
  });

  it('no link for a value that is not an http(s) URL', () => {
    fakeApi();
    renderApp(panel('just text https://x.example'));
    expect(screen.queryByTestId('props-open')).toBeNull();
  });
});
