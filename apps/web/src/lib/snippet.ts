/** The window [start, stop) of `text` that fits `budget` characters with [i, end) centered; room one side doesn't need goes to the other. */
function windowAround(text: string, i: number, end: number, budget: number): [number, number] {
  const room = Math.max(0, budget - (end - i));
  let before = Math.floor(room / 2);
  let after = room - before;
  const tail = text.length - end;
  if (tail < after) { before += after - tail; after = tail; }
  if (i < before) { after += before - i; before = i; }
  return [i - before, Math.min(text.length, end + after)];
}

/**
 * The part of a search-result line that fits `budget` characters, with the first match of `q`
 * centered (#54): room one side doesn't need goes to the other. `…` marks a cut. Null: no match.
 */
export function snippet(text: string, q: string, budget: number): { pre: string; hit: string; post: string } | null {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return null;
  const end = i + q.length;
  const [start, stop] = windowAround(text, i, end, budget);
  return {
    pre: (start > 0 ? '…' : '') + text.slice(start, i),
    hit: text.slice(i, end),
    post: text.slice(end, stop) + (stop < text.length ? '…' : ''),
  };
}

/**
 * Like `snippet`, for the match ranges the server sends (#138: a stem or a folded spelling is not the query
 * text): the window centers the first range and every range in it is marked. `…` marks a cut.
 */
export function markedSnippet(text: string, ranges: readonly (readonly [number, number])[], budget: number): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }];
  const [start, stop] = windowAround(text, ranges[0]![0], ranges[0]![1], budget);
  const parts: { text: string; hit: boolean }[] = [];
  let at = start;
  for (const [a, b] of ranges) {
    const s = Math.max(a, at);
    const e = Math.min(b, stop);
    if (e <= s) continue;
    if (s > at) parts.push({ text: text.slice(at, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < stop) parts.push({ text: text.slice(at, stop), hit: false });
  if (start > 0) parts.unshift({ text: '…', hit: false });
  if (stop < text.length) parts.push({ text: '…', hit: false });
  // Neighbouring plain parts (the cut marks) joined.
  return parts.reduce<{ text: string; hit: boolean }[]>((out, p) => {
    const last = out.at(-1);
    if (last && !last.hit && !p.hit) last.text += p.text;
    else out.push({ ...p });
    return out;
  }, []);
}
