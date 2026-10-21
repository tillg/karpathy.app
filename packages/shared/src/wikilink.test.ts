import { describe, expect, it } from 'vitest';
import { parseWikilink, resolveWikilink, wikilinkLabel } from './wikilink.js';

const paths = ['index.md', 'log.md', 'wiki/concepts/llm-wiki.md', 'wiki/entities/obsidian.md', 'raw/notes.txt', 'wiki/entities/Andrej Karpathy.md'];

describe('parseWikilink', () => {
  it('parses target, heading and alias', () => {
    expect(parseWikilink('concepts/llm-wiki#Kernidee|the idea')).toEqual({ target: 'concepts/llm-wiki', heading: 'Kernidee', alias: 'the idea' });
    expect(parseWikilink('index')).toEqual({ target: 'index' });
    expect(parseWikilink('#Local heading')).toEqual({ target: '', heading: 'Local heading' });
  });
  it('escaped alias pipe: the table-safe [[target\\|alias]] (#118)', () => {
    expect(parseWikilink('nadine-gartner\\|Nadine')).toEqual({ target: 'nadine-gartner', alias: 'Nadine' });
    expect(parseWikilink('a/b#Plot\\|the plot')).toEqual({ target: 'a/b', heading: 'Plot', alias: 'the plot' });
  });
  it('labels with alias or last segment', () => {
    expect(wikilinkLabel(parseWikilink('a/b/c|Alias'))).toBe('Alias');
    expect(wikilinkLabel(parseWikilink('a/b/c#h'))).toBe('c');
  });
});

describe('resolveWikilink', () => {
  it('resolves an exact path', () => expect(resolveWikilink('raw/notes.txt', paths)).toBe('raw/notes.txt'));
  it('adds .md', () => expect(resolveWikilink('wiki/concepts/llm-wiki', paths)).toBe('wiki/concepts/llm-wiki.md'));
  it('matches a path suffix', () => expect(resolveWikilink('entities/obsidian', paths)).toBe('wiki/entities/obsidian.md'));
  it('matches a basename anywhere, case-insensitive', () => {
    expect(resolveWikilink('llm-wiki', paths)).toBe('wiki/concepts/llm-wiki.md');
    expect(resolveWikilink('andrej karpathy', paths)).toBe('wiki/entities/Andrej Karpathy.md');
  });
  it('returns null when nothing matches', () => {
    expect(resolveWikilink('concepts/rag', paths)).toBeNull();
    expect(resolveWikilink('', paths)).toBeNull();
  });
});

describe('resolveWikilink with several matches', () => {
  const dup = ['z/deep/image.png', 'a/image.png', 'Notes/image.png', 'Notes/n.md', 'b/image.png'];
  it('prefers the note’s folder, then the shortest path, then A–Z', () => {
    expect(resolveWikilink('image.png', dup, 'Notes/n.md')).toBe('Notes/image.png');
    expect(resolveWikilink('image.png', dup)).toBe('a/image.png');
    expect(resolveWikilink('image.png', dup, 'Other/x.md')).toBe('a/image.png');
  });
  it('applies to note names and path suffixes too', () => {
    const notes = ['z/Idea.md', 'a/b/Idea.md', 'q/Idea.md'];
    expect(resolveWikilink('Idea', notes)).toBe('q/Idea.md');
    expect(resolveWikilink('Idea', notes, 'a/b/n.md')).toBe('a/b/Idea.md');
    expect(resolveWikilink('b/Idea', ['x/b/Idea.md', 'b/Idea.md', 'y/b/Idea.md'])).toBe('b/Idea.md');
  });
});

describe('resolveWikilink (indexed) matches the plain linear scan', () => {
  // The rules as a plain scan over every path: what the basename index must reproduce exactly.
  const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const pick = (m: string[], from?: string) => {
    const here = from === undefined ? undefined : dirOf(from);
    return [...m].sort((a, b) => Number(dirOf(b) === here) - Number(dirOf(a) === here) || a.split('/').length - b.split('/').length || a.toLowerCase().localeCompare(b.toLowerCase()))[0];
  };
  const linear = (target: string, paths: string[], from?: string): string | null => {
    const t = target.replace(/^\/+/, '');
    if (!t) return null;
    if (paths.includes(t)) return t;
    if (paths.includes(`${t}.md`)) return `${t}.md`;
    const s = pick(paths.filter((p) => p.endsWith(`/${t}.md`) || p.endsWith(`/${t}`)), from);
    if (s) return s;
    const name = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
    return pick(paths.filter((p) => { const b = p.slice(p.lastIndexOf('/') + 1).toLowerCase(); return b === name || b === `${name}.md`; }), from) ?? null;
  };
  it('for many targets, case variants, folders and extensions', () => {
    const paths = ['Idea.md', 'a/Idea.md', 'a/b/idea.MD', 'q/IDEA.md', 'x.md.md', 'x/x.md', 'img/p.png', 'b/p.png', 'n/Notes.md', 'n/sub/notes', 'Deep/a/b/c.md', 'c'];
    const targets = ['Idea', 'idea', 'IDEA.md', 'a/Idea', 'b/idea', 'b/idea.MD', 'x.md', 'x', 'p.png', 'P.PNG', 'img/p', 'notes', 'sub/notes', 'a/b/c', 'c', 'C.md', '/a/Idea', 'nothing', 'b/', ''];
    for (const t of targets) for (const from of [undefined, 'a/n.md', 'q/n.md', 'n/sub/x.md', 'img/x.md']) expect(resolveWikilink(t, paths, from), `${t} from ${from}`).toBe(linear(t, paths, from));
  });
});
