import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prompt } from '../../../prompts/load.js';
import { testDir } from './opencode-container.js';

// The prompt file loader (prompts/load.ts, #149), on fixture files instead of the real prompts/.

const dir = testDir('prompt-load');
mkdirSync(dir, { recursive: true });
const base = pathToFileURL(`${dir}/`);
const write = (name: string, text: string) => writeFileSync(join(dir, `${name}.md`), text);
const load = (name: string, text: string) => (write(name, text), prompt(name, base));

describe('prompt files', () => {
  it('body without frontmatter is the text', () => {
    expect(load('plain', 'Just the text.\n').text).toBe('Just the text.');
  });

  it('leading/trailing newlines trimmed, inner bytes kept', () => {
    expect(load('bytes', '---\nvariables: []\n---\n\n  Line one.\n\n\tLine two  \n\n').text).toBe('  Line one.\n\n\tLine two  ');
  });

  it('unknown frontmatter key throws with the file name', () => {
    expect(() => load('unknown', '---\nargs: {}\n---\nText')).toThrow(/unknown\.md.*args/);
  });

  it('placeholder not in variables throws', () => {
    expect(() => load('undeclared', '---\nvariables: [a]\n---\n{{a}} and {{b}}')).toThrow(/undeclared\.md.*\bb\b/);
    expect(() => load('novars', 'Hello {{name}}')).toThrow(/novars\.md.*name/);
  });

  it('declared but unused variable throws', () => {
    expect(() => load('unused', '---\nvariables: [a, b]\n---\n{{a}}')).toThrow(/unused\.md.*\bb\b/);
  });

  it('render with a missing or an extra key throws', () => {
    const p = load('tpl', '---\nvariables: [time, zone]\n---\nIt is {{time}} in {{zone}}.');
    expect(p.render({ time: '10:00', zone: 'Europe/Berlin' })).toBe('It is 10:00 in Europe/Berlin.');
    expect(() => p.render({ time: '10:00' })).toThrow(/tpl\.md.*zone/);
    expect(() => p.render({ time: '10:00', zone: 'Z', extra: 'x' })).toThrow(/tpl\.md.*extra/);
  });

  it('a value containing {{x}} is not expanded again', () => {
    const p = load('once', '---\nvariables: [a, b]\n---\n{{a}}/{{b}}');
    expect(p.render({ a: '{{b}}', b: '$& $1' })).toBe('{{b}}/$& $1');
  });

  it('missing file throws at prompt()', () => {
    expect(() => prompt('no-such-prompt', base)).toThrow(/no-such-prompt\.md/);
  });
});
