import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appendReport, checkReport, lintMarkdown, writtenFiles } from '../../../deploy/opencode/lib/md-lint.js';
import { testDir } from './opencode-container.js';

// The Markdown check run after every AI write of a .md file (#118). Cases are shapes found in real vaults.

const rules = (text: string) => lintMarkdown(text).map((f) => [f.rule, f.line]);

describe('wikilink-wrapped', () => {
  it('finds a link wrapped onto the next line', () => {
    const text = 'Stop 1 ist gebucht: [[phi-hotel-canalgrande|Phi Hotel\nCanalgrande]] in Modena.';
    expect(lintMarkdown(text)).toEqual([
      expect.objectContaining({ rule: 'wikilink-wrapped', line: 1, text: '[[phi-hotel-canalgrande|Phi Hotel' }),
    ]);
  });
  it('finds a wrap inside a blockquote and inside a list item', () => {
    expect(rules('# H\n\n> ✅ GEBUCHT: [[source-piemont|Duchessa\n> Margherita]] in Vicoforte')).toEqual([['wikilink-wrapped', 3]]);
    expect(rules('- Tradition [[traumhaeuser|Der Hof\n  (S03/E04)]]')).toEqual([['wikilink-wrapped', 1]]);
  });
  it('finds a link wrapped twice and a wrapped embed', () => {
    expect(rules('a [[x|one\ntwo\nthree]] b')).toEqual([['wikilink-wrapped', 1]]);
    expect(rules('text\n![[image\nembeds]]')).toEqual([['wikilink-wrapped', 2]]);
  });
  it('ignores links on one line', () => {
    expect(lintMarkdown('[[a]] and [[b|B]] and ![[c.png]]\n[[d#h|D]]')).toEqual([]);
  });
  it('ignores clipped prose with a lone [[ before a later link', () => {
    const text = '(c) Type [[ to link a note.\n(d) Jump between items.\n(h) The same goes for your ![[image embeds]].';
    expect(lintMarkdown(text)).toEqual([]);
  });
  it('ignores fenced code and inline code', () => {
    expect(lintMarkdown('```\n[[a|b\nc]]\n```')).toEqual([]);
    expect(lintMarkdown('~~~js\nconst x = "[[a|b\nc]]";\n~~~')).toEqual([]);
    expect(lintMarkdown('use `[[a|b` and\nthen `c]]` here')).toEqual([]);
  });
});

describe('table-wikilink-pipe', () => {
  const table = (row: string) => `| Person | Rolle |\n|---|---|\n${row}`;
  it('finds an unescaped alias pipe in a table row, with the escaped fix', () => {
    expect(lintMarkdown(table('| [[nadine-gartner|Nadine]] | kommt Fr |'))).toEqual([
      { rule: 'table-wikilink-pipe', line: 3, text: '[[nadine-gartner|Nadine]]', fix: '[[nadine-gartner\\|Nadine]]' },
    ]);
  });
  it('finds every pipe link in a row, also in an indented row', () => {
    expect(rules(table('| [[a|A]] & [[b#h|B]] | x |'))).toEqual([['table-wikilink-pipe', 3], ['table-wikilink-pipe', 3]]);
    expect(rules(table('  | Marion & [[heinz-walter-hinrichs|Henry]] | dabei |'))).toEqual([['table-wikilink-pipe', 3]]);
  });
  it('ignores escaped pipes, links without alias and pipe links outside tables', () => {
    expect(lintMarkdown(table('| [[nadine-gartner\\|Nadine]] | [[bruno]] |'))).toEqual([]);
    expect(lintMarkdown('Kurztrip zu [[baerbel|Bärbel]]s 70. Geburtstag')).toEqual([]);
  });
  it('ignores Dataview code with || and pipe links', () => {
    expect(lintMarkdown('```dataviewjs\n| [[a|b]] |\nconst x = a || b;\n```')).toEqual([]);
  });
});

describe('written files', () => {
  it('takes filePath from edit, write and multiedit', () => {
    for (const tool of ['edit', 'write', 'multiedit']) expect(writtenFiles(tool, { filePath: '/vaults/v/Wiki/a.md' }, {})).toEqual(['/vaults/v/Wiki/a.md']);
  });
  it('takes the files of a patch, moved ones under their new path', () => {
    const metadata = { files: [{ filePath: '/vaults/v/a.md' }, { filePath: '/vaults/v/old.md', movePath: '/vaults/v/new.md' }, { filePath: '/vaults/v/b.txt' }] };
    expect(writtenFiles('apply_patch', { patchText: '…' }, metadata)).toEqual(['/vaults/v/a.md', '/vaults/v/old.md', '/vaults/v/new.md']);
    expect(writtenFiles('patch', {}, metadata)).toEqual(['/vaults/v/a.md', '/vaults/v/old.md', '/vaults/v/new.md']);
  });
  it('drops other files and other tools', () => {
    expect(writtenFiles('write', { filePath: 'notes.txt' }, {})).toEqual([]);
    expect(writtenFiles('save_url', { filePath: 'a.md' }, {})).toEqual([]);
    expect(writtenFiles('read', { filePath: 'a.md' }, {})).toEqual([]);
    expect(writtenFiles('edit', undefined, undefined)).toEqual([]);
  });
});

describe('report', () => {
  it('names the file and one line per finding with rule, line and fix', () => {
    const findings = lintMarkdown('| A | B |\n|---|---|\n| [[a|A]] | x |\n\nsee [[b|long\nalias]]');
    const report = checkReport('Wiki/x.md', findings);
    expect(report).toContain('Markdown problems in Wiki/x.md');
    expect(report).toContain('- line 3 [table-wikilink-pipe] `[[a|A]]`');
    expect(report).toContain('`[[a\\|A]]`');
    expect(report).toContain('- line 5 [wikilink-wrapped] `[[b|long`');
    expect(report.trim().split('\n')).toHaveLength(3);
  });
  it('is empty without findings', () => expect(checkReport('Wiki/x.md', [])).toBe(''));
});

describe('hook', () => {
  const vault = join(testDir('md-lint'), 'vault');
  const broken = '| A | B |\n|---|---|\n| [[a|A]] | x |\n';
  const call = async (tool: string, args: unknown, metadata: unknown = {}) => {
    const output = { title: '', output: 'Edit applied successfully.', metadata };
    await appendReport(vault, { tool, args }, output);
    return output.output;
  };

  it('appends the report after a write of a broken .md file, with the vault path', async () => {
    await mkdir(join(vault, 'Wiki'), { recursive: true });
    await writeFile(join(vault, 'Wiki/broken.md'), broken);
    const out = await call('write', { filePath: join(vault, 'Wiki/broken.md') });
    expect(out).toMatch(/^Edit applied successfully\.\n\nMarkdown problems in Wiki\/broken\.md/);
    expect(out).toContain('[table-wikilink-pipe]');
    // A relative path resolves against the vault.
    expect(await call('edit', { filePath: 'Wiki/broken.md' })).toContain('Markdown problems in Wiki/broken.md');
  });
  it('reports every file of a patch', async () => {
    await writeFile(join(vault, 'two.md'), 'see [[b|long\nalias]]');
    const out = await call('apply_patch', {}, { files: [{ filePath: join(vault, 'Wiki/broken.md') }, { filePath: join(vault, 'two.md') }] });
    expect(out).toContain('Markdown problems in Wiki/broken.md');
    expect(out).toContain('Markdown problems in two.md');
  });
  it('leaves the output alone for a clean file, a missing file, a non-.md file and other tools', async () => {
    await writeFile(join(vault, 'clean.md'), '| A |\n|---|\n| [[a\\|A]] |\n');
    await writeFile(join(vault, 'notes.txt'), broken);
    for (const [tool, file] of [['write', 'clean.md'], ['write', 'gone.md'], ['write', 'notes.txt'], ['read', 'Wiki/broken.md']] as const)
      expect(await call(tool, { filePath: join(vault, file) })).toBe('Edit applied successfully.');
  });
  it('never throws: a check that fails leaves the output alone', async () => {
    await mkdir(join(vault, 'dir.md'), { recursive: true });
    expect(await call('write', { filePath: join(vault, 'dir.md') })).toBe('Edit applied successfully.');
  });
});

describe('review fixes (adversarial review)', () => {
  it('a fence line with an info string does not close a block', () => {
    expect(lintMarkdown('```\n```js\n[[a|b\nc]]\n```')).toEqual([]);
  });
  it('CRLF: a paragraph break is still a break, a real wrap is still found', () => {
    expect(lintMarkdown('Type [[ to link.\r\n\r\nthen ]] end')).toEqual([]);
    expect(lintMarkdown('a [[x|one\r\ntwo]] b')).toEqual([expect.objectContaining({ rule: 'wikilink-wrapped', line: 1, text: '[[x|one' })]);
  });
  it('skips frontmatter and keeps the line numbers after it', () => {
    expect(lintMarkdown('---\nsummary: siehe [[a|b\n  c]]\n---\n# T')).toEqual([]);
    expect(rules('---\nx: 1\n---\n[[a|b\nc]]')).toEqual([['wikilink-wrapped', 4]]);
  });
  it('skips HTML comments', () => {
    expect(lintMarkdown('<!-- [[a|b\nc]] -->\n<!--\n| A |\n|---|\n| [[a|A]] |\n-->')).toEqual([]);
  });
  it('a table row needs a table: a delimiter row in its block; tables in blockquotes count', () => {
    expect(lintMarkdown('| not a table, see [[a|b]]')).toEqual([]);
    expect(rules('> | A |\n> |---|\n> | [[a|A]] |')).toEqual([['table-wikilink-pipe', 3]]);
  });
  it('finds a short pipe link after a long one (no regex state carried over)', () => {
    expect(rules('| A |\n|---|\n| [[a-long-target-name|X]] |\n| [[a|B]] |')).toEqual([['table-wikilink-pipe', 3], ['table-wikilink-pipe', 4]]);
  });
  it('escapes every pipe of [[a||b]]', () => {
    expect(lintMarkdown('| A |\n|---|\n| [[a||b]] |')[0]?.fix).toBe('[[a\\|\\|b]]');
  });
  it('a snippet with a backtick still reads as inline code in the report', () => {
    const report = checkReport('x.md', [{ rule: 'wikilink-wrapped', line: 1, text: '[[a|`b', fix: 'put the whole link on one line' }]);
    expect(report).toContain('`` [[a|`b ``');
  });
  it('an unexpected read error is logged and leaves the output alone', async () => {
    const vault = join(testDir('md-lint-eacces'), 'vault');
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, 'locked.md'), '| A |\n|---|\n| [[a|A]] |\n');
    await chmod(join(vault, 'locked.md'), 0o000);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const output = { output: 'ok', metadata: {} };
    await appendReport(vault, { tool: 'write', args: { filePath: 'locked.md' } }, output);
    expect(output.output).toBe('ok');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^md-lint: locked\.md: .*EACCES/));
    log.mockRestore();
  });
});
