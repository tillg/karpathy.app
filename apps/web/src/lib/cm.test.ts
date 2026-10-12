// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { copiesOnKeyup, liveMarkdown } from './cm';

const hooks = { resolve: () => ({ state: 'missing', target: '' }) as never, ctx: () => ({}) as never, epoch: () => 0 };

describe('live preview wikilinks', () => {
  it('#118 the table-safe [[target\\|alias]] resolves its target', () => {
    const view = new EditorView({
      doc: '| A |\n|---|\n| [[nadine-gartner\\|Nadine]] |\n',
      extensions: liveMarkdown((t) => t === 'nadine-gartner', () => {}, hooks),
      parent: document.body,
    });
    const link = view.dom.querySelector('.cm-wl');
    expect(link?.textContent).toBe('nadine-gartner\\|Nadine');
    expect(link?.classList.contains('cm-wl-miss')).toBe(false);
    view.destroy();
  });
});

describe('copy on select by key (#144)', () => {
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });

  it('copies after shift-based selection keys', () => {
    expect(copiesOnKeyup(k('ArrowLeft', { shiftKey: true }))).toBe(true);
    expect(copiesOnKeyup(k('End', { shiftKey: true }))).toBe(true);
    expect(copiesOnKeyup(k('PageDown', { shiftKey: true }))).toBe(true);
    expect(copiesOnKeyup(k('ArrowRight', { shiftKey: true, altKey: true }))).toBe(true);
  });

  it('never copies for Cmd/Ctrl combos (select-all, find next) or a released Shift', () => {
    expect(copiesOnKeyup(k('a', { metaKey: true }))).toBe(false);
    expect(copiesOnKeyup(k('g', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(copiesOnKeyup(k('a', { ctrlKey: true }))).toBe(false);
    expect(copiesOnKeyup(k('ArrowLeft', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(copiesOnKeyup(k('Shift'))).toBe(false);
    expect(copiesOnKeyup(k('ArrowLeft'))).toBe(false);
  });
});
