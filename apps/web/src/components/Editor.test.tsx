// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('Copy on select (#144)', () => {
  // jsdom has no clipboard: a recording stand-in; `reject` makes the write fail like a denied permission.
  const clipboard = (reject = false) => {
    const writeText = vi.fn(() => (reject ? Promise.reject(new Error('denied')) : Promise.resolve()));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  };
  const setup = (onCopied = vi.fn()) => {
    const { container } = render(<Editor {...base} path="a/x.md" doc={'hello brave world\nsecond'} onCopied={onCopied} />);
    const content = container.querySelector<HTMLElement>('.cm-content')!;
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    return { content, view, onCopied };
  };

  it('copies a selection on mouseup and reports it once', async () => {
    const write = clipboard();
    const { content, view, onCopied } = setup();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    fireEvent.mouseUp(content);
    expect(write).toHaveBeenCalledWith('brave');
    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1));
  });

  it('copies on keyup (shift+arrows) and on touchend', () => {
    const write = clipboard();
    const { content, view } = setup();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.keyUp(content, { key: 'ArrowRight', shiftKey: true });
    expect(write).toHaveBeenLastCalledWith('hello');
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    fireEvent.touchEnd(content);
    expect(write).toHaveBeenLastCalledWith('brave');
  });

  it('does not copy an empty or an unchanged selection twice', () => {
    const write = clipboard();
    const { content, view } = setup();
    fireEvent.mouseUp(content);
    expect(write).not.toHaveBeenCalled();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.mouseUp(content);
    fireEvent.keyUp(content, { key: 'Shift' });
    expect(write).toHaveBeenCalledTimes(1);
    // Cleared and selected again: copied again (the clipboard may have changed meanwhile).
    view.dispatch({ selection: { anchor: 3 } });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.mouseUp(content);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('fails silently when the clipboard write is rejected', async () => {
    const write = clipboard(true);
    const { content, view, onCopied } = setup();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.mouseUp(content);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(write).toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
