/**
 * URLs in the terminal, across line breaks (#175). Programs like Claude Code wrap long lines themselves, with real line
 * breaks, so xterm sees separate rows and its web-links addon finds only the clicked row's piece of a long URL. Here a
 * row that runs to the right edge and a next row that starts without a space read as one line, as on screen.
 */
export interface TermLink {
  url: string;
  /** 0-based cells, inclusive. */
  start: { x: number; y: number };
  end: { x: number; y: number };
}

const URL_RE = /https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g;

/** The links that touch row `y` of `rows` (each row's text, `cols` wide). */
export function linksAt(rows: string[], cols: number, y: number): TermLink[] {
  const full = (i: number) => (rows[i] ?? '').trimEnd().length >= cols;
  const continues = (i: number) => i < rows.length && /^\S/.test(rows[i] ?? '');
  let first = y;
  while (first > 0 && full(first - 1) && continues(first)) first--;
  let last = y;
  while (full(last) && continues(last + 1)) last++;

  // The joined text, and where each row starts in it.
  const starts: number[] = [];
  let text = '';
  for (let i = first; i <= last; i++) {
    starts.push(text.length);
    text += i < last ? (rows[i] ?? '').slice(0, cols) : (rows[i] ?? '').trimEnd();
  }
  const at = (offset: number) => {
    let i = starts.length - 1;
    while (starts[i]! > offset) i--;
    return { x: offset - starts[i]!, y: first + i };
  };

  const out: TermLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = at(m.index);
    const end = at(m.index + m[0].length - 1);
    if (start.y <= y && end.y >= y) out.push({ url: m[0], start, end });
  }
  return out;
}

/**
 * The selection's text for the clipboard. xterm ends every row a program broke itself with a line break, so a copied
 * long URL came out in pieces. `rows`: the buffer rows the selection covers, from its first; a row that runs to the
 * right edge and a next line that starts without a space join without a break.
 */
export function joinSelection(text: string, rows: string[], cols: number): string {
  const lines = text.split('\n');
  let out = lines[0] ?? '';
  for (let i = 1; i < lines.length; i++) {
    const join = (rows[i - 1] ?? '').trimEnd().length >= cols && /^\S/.test(lines[i]!);
    out += (join ? '' : '\n') + lines[i];
  }
  return out;
}
