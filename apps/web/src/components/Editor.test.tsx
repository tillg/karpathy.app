// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from './Editor';

afterEach(cleanup);

const base = {
  readOnly: false,
  onChange: () => {},
  exists: () => true,
  onWikilink: () => {},
  resolveEmbed: () => ({ state: 'missing' }) as never,
  embedCtx: () => ({}) as never,
  mediaEpoch: 0,
};

describe('Editor kind (#126)', () => {
  it('code kind: [[x]] in a .py file is no wikilink', () => {
    const { container } = render(<Editor {...base} kind="code" path="a/run.py" doc={'x = "[[Home]]"\n'} />);
    expect(container.querySelector('.cm-content')?.textContent).toContain('[[Home]]');
    expect(container.querySelector('.cm-wl')).toBeNull();
  });

  it('code kind: a Python keyword gets a highlight class once the language has loaded', async () => {
    const { container } = render(<Editor {...base} kind="code" path="a/run.py" doc={'def main():\n    pass\n'} />);
    await waitFor(() => {
      const def = [...container.querySelectorAll('.cm-line span')].find((s) => s.textContent === 'def');
      expect(def?.className).toBeTruthy();
    });
  });

  it('code kind: plain text keeps every line', () => {
    const { container } = render(<Editor {...base} kind="code" path="notes.txt" doc={'one\ntwo\nthree'} />);
    expect(container.querySelectorAll('.cm-line')).toHaveLength(3);
  });

  it('note kind unchanged: [[x]] is a wikilink', () => {
    const { container } = render(<Editor {...base} kind="note" path="a/x.md" doc={'See [[Home]]\n'} />);
    expect(container.querySelector('.cm-wl')?.textContent).toBe('Home');
  });
});
