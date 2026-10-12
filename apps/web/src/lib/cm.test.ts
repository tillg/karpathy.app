// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { liveMarkdown } from './cm';

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
