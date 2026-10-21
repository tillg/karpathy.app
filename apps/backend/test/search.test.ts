import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLanguage, fold, MAX_QUERY_WORDS, parseQuery, SearchIndex, wordTerms } from '../src/search.js';

const DE = 'Gestern haben wir im Kaufhaus neue Handtücher gekauft. Die alten Tücher waren schon ganz dünn und hatten Löcher.';
const EN = 'Yesterday we went to the department store and bought new towels, because the old ones were worn out and thin.';
const FR = 'Hier, nous sommes allés au grand magasin et nous avons acheté des chevaux en bois pour les enfants du village.';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function vault(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'search-'));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  const index = new SearchIndex(root);
  const q = async (s: string) => (await index.search(s)).hits;
  const paths = async (s: string) => [...new Set((await q(s)).map((h) => h.path))];
  return { root, index, q, paths };
}

describe('text analysis', () => {
  it('folds case and diacritics', () => {
    expect(fold('Handtücher')).toBe('handtucher');
    expect(fold('Straße')).toBe('strasse');
    expect(fold('Œuvre Café')).toBe('oeuvre cafe');
  });

  it('detects German, English and French; too little text has no language', () => {
    expect(detectLanguage(DE)).toBe('de');
    expect(detectLanguage(EN)).toBe('en');
    expect(detectLanguage(FR)).toBe('fr');
    expect(detectLanguage('Handtücher')).toBeNull();
  });

  it('a frontmatter lang wins over the detector', () => {
    expect(detectLanguage(EN, 'title: x\nlang: de')).toBe('de');
    expect(detectLanguage(EN, 'lang: xx')).toBe('en');
  });

  it('stems in the note language; ue spells ü in German', () => {
    expect(wordTerms('Handtücher', 'de')).toEqual(wordTerms('Handtuch', 'de'));
    expect(wordTerms('Handtuecher', 'de')).toEqual(wordTerms('Handtücher', 'de'));
    expect(wordTerms('chevaux', 'fr')).toEqual(wordTerms('cheval', 'fr'));
    expect(wordTerms('running', 'en')).toEqual(wordTerms('runs', 'en'));
  });
});

describe('SearchIndex', () => {
  it('#138 "handtuch" finds a note with "Handtücher" and marks the word', async () => {
    const v = await vault({ 'Haushalt.md': `# Einkauf\n\n${DE}\n`, 'Other.md': EN });
    const hits = await v.q('handtuch');
    expect(hits).toEqual([{ path: 'Haushalt.md', line: 3, text: DE, ranges: [[DE.indexOf('Handtücher'), DE.indexOf('Handtücher') + 'Handtücher'.length]] }]);
    expect(v.index.languageOf('Haushalt.md')).toBe('de');
    expect(await v.paths('Handtuecher')).toEqual(['Haushalt.md']);
    expect(await v.paths('HANDTUCHER')).toEqual(['Haushalt.md']);
  });

  it('a short note without a detectable language still matches by every stemmer', async () => {
    const v = await vault({ 'Liste.md': '- Handtücher kaufen\n' });
    expect(v.index.languageOf('Liste.md')).toBeUndefined();
    expect(await v.paths('handtuch')).toEqual(['Liste.md']);
  });

  it('stems English and French notes', async () => {
    const v = await vault({ 'en.md': EN, 'fr.md': FR });
    expect(await v.paths('towel')).toEqual(['en.md']);
    expect(await v.paths('cheval')).toEqual(['fr.md']);
    expect(await v.paths('cafe')).toEqual([]);
  });

  it('ranks by BM25: a short note about the word before a long one mentioning it once; file name first', async () => {
    const filler = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const v = await vault({
      'a-long.md': `${filler} glacier ${filler}\n`,
      'b-short.md': 'glacier glacier ice\n',
      'z/Glacier.md': 'nothing here about it\n',
    });
    expect(await v.paths('glacier')).toEqual(['z/Glacier.md', 'b-short.md', 'a-long.md']);
  });

  it('headings and frontmatter count more than body text', async () => {
    const v = await vault({
      'a.md': 'some text about lakes and a moraine somewhere in it\n',
      'b.md': '# Moraine\nsome text about lakes and somewhere in it\n',
      'c.md': '---\ntags: [moraine]\n---\nsome text about lakes and somewhere in it\n',
    });
    expect(await v.paths('moraine')).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('the last word is a prefix; earlier ones are not', async () => {
    const v = await vault({ 'a.md': 'Handtuchhalter montieren\n', 'b.md': 'handt\n' });
    expect(await v.paths('handt')).toEqual(['b.md', 'a.md']);
    expect(await v.paths('handt montieren')).toEqual([]);
  });

  it('tolerates a typo only when the word matches nothing', async () => {
    const v = await vault({ 'a.md': 'the Similaun glacier\n', 'b.md': 'similar\n' });
    expect(await v.paths('glaicer')).toEqual(['a.md']);
    expect(await v.paths('similar')).toEqual(['b.md']);
  });

  it('a typo finds a word indexed by a short stem, in the name and in the text, and marks it', async () => {
    const v = await vault({ 'Kitchen Renovation.md': `# Plan\n\n${EN}\n`, 'b.md': `${EN} The renovation of the kitchen starts in May.\n` });
    expect(await v.paths('renovaton')).toEqual(['Kitchen Renovation.md', 'b.md']);
    expect(v.index.languageOf('b.md')).toBe('en');
    const [hit] = (await v.q('renovaton')).filter((h) => h.path === 'b.md');
    expect(hit!.text.slice(...hit!.ranges![0]!)).toBe('renovation');
  });

  it('several words: all must match; a quoted phrase matches as written', async () => {
    const v = await vault({ 'a.md': 'Similaun\n\nCevedale\n', 'b.md': 'Similaun Cevedale\n', 'c.md': 'Similaun\n' });
    expect((await v.paths('similaun cevedale')).sort()).toEqual(['a.md', 'b.md']);
    expect(await v.q('"similaun cevedale"')).toEqual([{ path: 'b.md', line: 1, text: 'Similaun Cevedale', ranges: [[0, 17]] }]);
  });

  it('a file found only by name gets one line-0 hit; binary files are found by name', async () => {
    const v = await vault({ 'Wiki/glacier-tour.md': 'nothing\n', 'pics/glacier.png': Buffer.from([0x89, 0x50, 0, 0, 1, 2]) });
    expect(await v.q('glacier')).toEqual([
      { path: 'pics/glacier.png', line: 0, text: 'pics/glacier.png' },
      { path: 'Wiki/glacier-tour.md', line: 0, text: 'Wiki/glacier-tour.md' },
    ]);
  });

  it('hidden files are not searched', async () => {
    const v = await vault({ '.obsidian/x.md': 'secretword\n', 'a.md': 'x\n' });
    expect(await v.q('secretword')).toEqual([]);
  });

  it('long lines are cut around the match; base64 lines are skipped', async () => {
    const long = `${'lorem '.repeat(100)}moraine ${'ipsum '.repeat(100)}`;
    const v = await vault({ 'a.md': `${long}\n${'QUJD'.repeat(30)}moraine\n` });
    const [hit, ...rest] = await v.q('moraine');
    expect(rest).toEqual([]);
    expect(hit!.text.length).toBeLessThanOrEqual(302);
    expect(hit!.text.startsWith('…') && hit!.text.endsWith('…')).toBe(true);
    const [s, e] = hit!.ranges![0]!;
    expect(hit!.text.slice(s, e)).toBe('moraine');
  });

  it('catches up with added, changed and deleted files when marked stale', async () => {
    const v = await vault({ 'a.md': 'alpha\n' });
    expect(await v.paths('alpha')).toEqual(['a.md']);
    await writeFile(join(v.root, 'b.md'), 'alpha beta\n');
    await writeFile(join(v.root, 'a.md'), 'gamma\n');
    v.index.markStale('a.md');
    v.index.markStale();
    expect(await v.paths('alpha')).toEqual(['b.md']);
    await unlink(join(v.root, 'b.md'));
    v.index.markStale();
    expect(await v.paths('alpha')).toEqual([]);
    expect(v.index.size).toBe(1);
  });

  it('a path marked stale is re-read alone; a hidden one is ignored', async () => {
    const v = await vault({ 'a.md': 'alpha\n' });
    expect(await v.paths('alpha')).toEqual(['a.md']);
    await writeFile(join(v.root, 'b.md'), 'alpha\n');
    await mkdir(join(v.root, '.trash'));
    await writeFile(join(v.root, '.trash/c.md'), 'alpha\n');
    v.index.markStale('b.md');
    v.index.markStale('.trash/c.md');
    expect(await v.paths('alpha')).toEqual(['a.md', 'b.md']);
  });

  it('finds files by full name and extension (as the old path search did)', async () => {
    const v = await vault({ 'docs/report.pdf': Buffer.from([0x25, 0x50, 0, 1]), 'Meeting.md': 'agenda\n', 'other.md': 'x\n' });
    expect(await v.paths('pdf')).toEqual(['docs/report.pdf']);
    expect(await v.paths('report.pdf')).toEqual(['docs/report.pdf']);
    expect(await v.paths('Meeting.md')).toEqual(['Meeting.md']);
    expect(await v.paths('docs/report')).toEqual(['docs/report.pdf']);
  });

  it('a long query: repeated words count once, at most MAX_QUERY_WORDS words are looked up', async () => {
    expect(parseQuery('the '.repeat(1000))).toHaveLength(1);
    expect(parseQuery('Glacier glacier "a b" "A B" glacier')).toHaveLength(2);
    expect(parseQuery(Array.from({ length: 200 }, (_, i) => `w${i}x`).join(' '))).toHaveLength(MAX_QUERY_WORDS);
    const v = await vault({ 'a.md': 'the glacier\n', 'b.md': 'the moraine\n' });
    expect((await v.paths('the '.repeat(1000))).sort()).toEqual(['a.md', 'b.md']);
  });

  it('an incremental update never follows a symlink out of the vault', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'secret.md'), 'topsecretvalue\n');
    const v = await vault({ 'a.md': 'x\n' });
    await v.index.warm();
    await symlink(join(outside, 'secret.md'), join(v.root, 'link.md'));
    await symlink(outside, join(v.root, 'linkdir'));
    v.index.markStale('link.md');
    v.index.markStale('linkdir/secret.md');
    expect(await v.q('topsecretvalue')).toEqual([]);
  });

  it('an incremental update respects .gitignore like the full listing', async () => {
    const v = await vault({ '.gitignore': 'ignored/\n', 'a.md': 'x\n' });
    execFileSync('git', ['init', '-q'], { cwd: v.root });
    await v.index.warm();
    await mkdir(join(v.root, 'ignored'));
    await writeFile(join(v.root, 'ignored/b.md'), 'needle\n');
    await writeFile(join(v.root, 'c.md'), 'needle\n');
    v.index.markStale('ignored/b.md');
    v.index.markStale('c.md');
    expect(await v.paths('needle')).toEqual(['c.md']);
    v.index.markStale();
    expect(await v.paths('needle')).toEqual(['c.md']);
  });

  it('a changed .gitignore re-lists the vault', async () => {
    const v = await vault({ 'a.md': 'needle\n', 'b.md': 'needle\n' });
    execFileSync('git', ['init', '-q'], { cwd: v.root });
    expect(await v.paths('needle')).toEqual(['a.md', 'b.md']);
    await writeFile(join(v.root, '.gitignore'), 'b.md\n');
    v.index.markStale('.gitignore');
    expect(await v.paths('needle')).toEqual(['a.md']);
  });

  it('caps at 200 hits and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 80; i++) files[`n${i}.md`] = 'needle\nneedle\nneedle\n';
    const v = await vault(files);
    const r = await v.index.search('needle');
    expect(r.hits).toHaveLength(200);
    expect(r.truncated).toBe(true);
  });
});
