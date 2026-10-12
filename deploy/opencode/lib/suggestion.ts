/**
 * The suggest_next check (import-free, so the backend tests load it): one short single-line prompt. Too long is
 * an error the model sees and can retry with a shorter one. Nothing is read or written; the web app shows the
 * completed call as ghost text in the composer.
 */
export const MAX_SUGGESTION = 160;

export function cleanSuggestion(prompt: string): string {
  const p = prompt.replace(/\s+/g, ' ').trim();
  if (!p) throw new Error('The suggested prompt is empty');
  if (p.length > MAX_SUGGESTION) throw new Error(`The suggested prompt is too long (${p.length} characters): shorten it to at most ${MAX_SUGGESTION}`);
  return `suggested: ${p}`;
}
