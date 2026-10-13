// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSelectionText, selectionCopier } from './copy-select';

// jsdom has no clipboard: a recording stand-in; `reject` makes the write fail like a denied permission.
const clipboard = (reject = false) => {
  const writeText = vi.fn(() => (reject ? Promise.reject(new Error('denied')) : Promise.resolve()));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

describe('selectionCopier (#144)', () => {
  it('copies a new selection once, and again after the selection was empty', async () => {
    const write = clipboard();
    const copied = vi.fn();
    const copy = selectionCopier(copied);
    copy('beta');
    copy('beta');
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledTimes(1);
    copy('');
    copy('beta');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a refused write stays silent', async () => {
    clipboard(true);
    const copied = vi.fn();
    selectionCopier(copied)('beta');
    await new Promise((r) => setTimeout(r));
    expect(copied).not.toHaveBeenCalled();
  });
});

describe('readSelectionText', () => {
  afterEach(() => { document.body.innerHTML = ''; window.getSelection()?.removeAllRanges(); });

  it('is the selected text inside the container, and empty for a selection outside it', () => {
    document.body.innerHTML = '<div id="in"><p>alpha beta</p></div><div id="out"><p>gamma</p></div>';
    const inside = document.getElementById('in')!;
    const range = document.createRange();
    range.selectNodeContents(inside.querySelector('p')!);
    window.getSelection()!.addRange(range);
    expect(readSelectionText(inside)).toBe('alpha beta');
    window.getSelection()!.removeAllRanges();
    const other = document.createRange();
    other.selectNodeContents(document.querySelector('#out p')!);
    window.getSelection()!.addRange(other);
    expect(readSelectionText(inside)).toBe('');
  });
});
