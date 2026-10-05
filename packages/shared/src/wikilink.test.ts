import { describe, expect, it } from 'vitest';
import { parseWikilink, resolveWikilink, wikilinkLabel } from './wikilink.js';

const paths = ['index.md', 'log.md', 'wiki/concepts/llm-wiki.md', 'wiki/entities/obsidian.md', 'raw/notes.txt', 'wiki/entities/Andrej Karpathy.md'];

describe('parseWikilink', () => {
  it('parses target, heading and alias', () => {
    expect(parseWikilink('concepts/llm-wiki#Kernidee|the idea')).toEqual({ target: 'concepts/llm-wiki', heading: 'Kernidee', alias: 'the idea' });
    expect(parseWikilink('index')).toEqual({ target: 'index' });
    expect(parseWikilink('#Local heading')).toEqual({ target: '', heading: 'Local heading' });
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
