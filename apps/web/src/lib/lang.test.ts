import { describe, expect, it } from 'vitest';
import { fileKind, languageFor, viewMode } from './lang';

describe('fileKind', () => {
  it('follows the kind table', () => {
    const cases: [string, boolean, string][] = [
      ['A.MD', false, 'note'],
      ['dir/a.md', false, 'note'],
      ['a.markdown', false, 'note'],
      ['a.html', false, 'html'],
      ['a.HTM', false, 'html'],
      ['a.mdx', false, 'code'],
      ['a.txt', false, 'code'],
      ['a.py', false, 'code'],
      ['ops/Dockerfile', false, 'code'],
      ['a.unknown', false, 'code'],
      ['a.svg', false, 'media'],
      ['a.png', true, 'media'],
      ['a.pdf', true, 'binary'],
      ['a.md', true, 'binary'],
      ['a.eml', false, 'email'],
      ['Mail/A.EML', false, 'email'],
      ['a.eml', true, 'email'],
      ['Dash/Tasks.base', false, 'base'],
      ['a.BASE', false, 'base'],
    ];
    for (const [path, binary, kind] of cases) expect(fileKind(path, binary), path).toBe(kind);
  });
});

describe('languageFor', () => {
  it('finds the language by file name', () => {
    const cases: [string, string][] = [
      ['a.py', 'Python'],
      ['src/b.ts', 'TypeScript'],
      ['c.js', 'JavaScript'],
      ['D.java', 'Java'],
      ['e.sh', 'Shell'],
      ['ops/Dockerfile', 'Dockerfile'],
      ['p.html', 'HTML'],
    ];
    for (const [path, name] of cases) expect(languageFor(path)?.name, path).toBe(name);
  });

  it('is null for plain text and unknown names', () => {
    expect(languageFor('notes.txt')).toBeNull();
    expect(languageFor('x.unknownext')).toBeNull();
  });
});

describe('viewMode', () => {
  it('notes follow the mode, HTML pages the page mode, code files are always Write', () => {
    expect(viewMode('note', 'read', 'write')).toBe('read');
    expect(viewMode('html', 'read', 'write')).toBe('write');
    expect(viewMode('html', 'write', 'read')).toBe('read');
    expect(viewMode('code', 'read', 'read')).toBe('write');
  });
  it('a .base file has Write (its YAML) and Read (the table), like an HTML page (#91)', () => {
    expect(viewMode('base', 'write', 'read')).toBe('read');
    expect(viewMode('base', 'read', 'write')).toBe('write');
  });
  it('emails are always Read (#166)', () => {
    expect(viewMode('email', 'write', 'write')).toBe('read');
  });
});
