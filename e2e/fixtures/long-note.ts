// `Long.md` for the outline specs: frontmatter, 30 heading-like lines over levels 1–4 (setext `===` and `---`,
// one in a callout, one in a code fence, one in a %% comment) and a body of exactly BODY_WORDS words, counted
// with the same word segmenter the app uses.

export const BODY_WORDS = 2200;
/** Words of the first body paragraph (the selection case). */
export const FIRST_PARA = 'First paragraph with exactly twelve words in it for the selection test.';
export const FIRST_PARA_WORDS = 12;

export interface Heading { level: number; text: string; line: number }

const FRONTMATTER = [
  '---',
  'title: Long note for the outline test',
  'tags: [outline, test, fixture]',
  'type: synthesis',
  'updated: 2026-10-04',
  'sources: [a.md, b.md]',
  'confidence: high',
  '---',
];

const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
const words = (s: string) => [...seg.segment(s)].filter((x) => x.isWordLike).length;
const FILLER = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron sigma tau omega'.split(' ');
const filler = (n: number, at = 0) => Array.from({ length: n }, (_, i) => FILLER[(at + i) % FILLER.length]).join(' ') + (n ? '.' : '');

function build(pad: number): { text: string; headings: Heading[] } {
  const lines = [...FRONTMATTER, FIRST_PARA, ''];
  const headings: Heading[] = [];
  const LEVELS = [2, 3, 4, 2, 3];
  for (let i = 1; i <= 30; i++) {
    const name = `Section ${i}`;
    const level = i === 1 ? 1 : LEVELS[i % LEVELS.length]!;
    const at = lines.length + 1;
    if (i === 5) { lines.push(name, '==='); headings.push({ level: 1, text: name, line: at }); }
    else if (i === 9) { lines.push(name, '---'); headings.push({ level: 2, text: name, line: at }); }
    else if (i === 12) { lines.push('> [!note]', `> ## ${name}`, '> Inside the callout.'); headings.push({ level: 2, text: name, line: at + 1 }); }
    else if (i === 17) lines.push('```', `# ${name} fake`, '```');
    else if (i === 21) lines.push('%%', `## ${name} hidden`, '%%');
    else { lines.push(`${'#'.repeat(level)} ${name}`); headings.push({ level, text: name, line: at }); }
    lines.push('', filler(60, i), '');
    if (i === 30) lines.push(filler(pad), '');
  }
  return { text: lines.join('\n'), headings };
}

function make() {
  const body = (t: string) => t.slice(FRONTMATTER.join('\n').length + 1);
  const pad = BODY_WORDS - words(body(build(0).text));
  if (pad < 0) throw new Error('long-note: body over budget');
  const out = build(pad);
  if (words(body(out.text)) !== BODY_WORDS) throw new Error('long-note: word count off');
  return out;
}

export const { text: LONG, headings: LONG_HEADINGS } = make();
