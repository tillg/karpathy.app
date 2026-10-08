// The note's outline (#79): its headings from the same Lezer Markdown parser the editor uses, so Write
// and Read mode list the same headings.
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import type { Tree } from '@lezer/common';
import { splitFrontmatter } from './markdown';
import { parseWikilink, wikilinkLabel, WIKILINK_RE } from './wikilink';

export interface OutlineItem { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number }

const LEVEL: Record<string, OutlineItem['level']> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
};

/** A heading's text as the outline shows it: wikilinks by their label, no emphasis or code marks. */
const display = (raw: string) =>
  raw.replace(WIKILINK_RE, (_m, inner: string) => wikilinkLabel(parseWikilink(inner)))
    .replace(/\*\*|__|==|[*_`]/g, '')
    .replace(/\s+/g, ' ').trim() || '(untitled)';

/** Last frontmatter line (0 when the note has none): the closing `---` of a `---` block at the very start. */
export function frontmatterEndLine(text: string): number {
  const fm = splitFrontmatter(text.slice(0, 20_000)).frontmatter;
  return fm === null ? 0 : fm.split('\n').length + 2;
}

/** The `%%comment%%` ranges Read mode hides: from after an opening `%%` to after its closing one (or the end). */
export function commentRanges(text: string): [number, number][] {
  const marks = [...text.matchAll(/%%/g)].map((m) => m.index + 2);
  const out: [number, number][] = [];
  for (let i = 0; i < marks.length; i += 2) out.push([marks[i]!, marks[i + 1] ?? Infinity]);
  return out;
}

/** True when `pos` lies inside one of `ranges` (from `commentRanges`). */
export const inComment = (ranges: [number, number][], pos: number) => ranges.some(([from, to]) => pos >= from && pos < to);

/**
 * Headings of a parsed note; `slice(from, to)` reads the text, `lineAt(pos)` maps to 1-based lines. Headings in
 * the frontmatter (`title: x` + `---` parses as a setext heading) and in comments are skipped.
 */
export function collectHeadings(tree: Tree, slice: (from: number, to: number) => string, lineAt: (pos: number) => number, skip: { fmEnd: number; comments: [number, number][] }): OutlineItem[] {
  const out: OutlineItem[] = [];
  tree.iterate({
    enter: (n) => {
      const level = LEVEL[n.name];
      if (!level) return;
      const line = lineAt(n.from);
      if (line <= skip.fmEnd || inComment(skip.comments, n.from)) return false;
      // The heading's text without its marks (`#`s, closing `#`s, the setext underline).
      let text = '';
      let pos = n.from;
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (c.name !== 'HeaderMark') continue;
        text += slice(pos, c.from);
        pos = c.to;
      }
      text += slice(pos, n.to);
      out.push({ level, text: display(text), line });
      return false;
    },
  });
  return out;
}

/** Read mode: the outline of a note's text. */
export function outlineOfText(text: string): OutlineItem[] {
  const tree = commonmarkLanguage.parser.parse(text);
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  return collectHeadings(tree, (from, to) => text.slice(from, to), lineAt, { fmEnd: frontmatterEndLine(text), comments: commentRanges(text) });
}

/** Index of the heading whose section holds `topLine`, or -1 above the first heading. */
export function currentHeading(items: OutlineItem[], topLine: number): number {
  let i = -1;
  while (i + 1 < items.length && items[i + 1]!.line <= topLine) i++;
  return i;
}
