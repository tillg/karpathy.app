/**
 * The composer's ghost text (#145): the suggested next prompt, greyed out over the empty textarea, and a button
 * that accepts it. Soft keyboards have no Tab, so the button is the touch affordance; CSS shows "Tab" where there
 * is a hover pointer and "Tap" elsewhere. Pointer events pass through the text to the textarea.
 */
export function Ghost({ text, onAccept }: { text: string | null; onAccept(): void }) {
  if (!text) return null;
  return (
    <div className="ghost" data-testid="chat-ghost">
      <span className="ghost-t">{text}</span>
      {/* Mouse down would blur the composer; accepting focuses it again. */}
      <button type="button" className="ghost-use" data-testid="chat-suggestion" aria-label={`Use suggested prompt: ${text}`}
        onMouseDown={(e) => e.preventDefault()} onClick={onAccept}>
        <span className="ghost-tab">↹ Tab</span><span className="ghost-tap">Tap to use</span>
      </button>
    </div>
  );
}
