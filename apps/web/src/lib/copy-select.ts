/**
 * Copy on select (#144), like a terminal: call the returned function from a gesture handler (Safari only allows the
 * clipboard write there) with the current selection's text. It copies a selection once; an empty selection re-arms
 * it, so selecting the same text again copies again. A refused write stays silent.
 */
export function selectionCopier(onCopied: () => void): (text: string) => void {
  let last: string | null = null;
  return (text) => {
    if (!text) {
      last = null;
      return;
    }
    if (text === last) return;
    last = text;
    navigator.clipboard?.writeText(text).then(onCopied, () => {});
  };
}

/** The page selection's text when it lies inside `container`, else ''. */
export function readSelectionText(container: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return '';
  if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return '';
  return sel.toString();
}
