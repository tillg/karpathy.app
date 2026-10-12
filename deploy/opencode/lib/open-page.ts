import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the backend leaves the open page of each chat (apps/backend/src/open-page.ts), on the shared vaults volume.
 * A literal on purpose: the compose volume mounts at `/vaults` in the opencode container (deploy/compose.yml, the
 * image's WORKDIR) and the backend's `OPENCODE_VAULTS_DIR` names that same path; the opencode container gets no env for it.
 */
export const OPEN_PAGE_DIR = '/vaults/.open-page';

/**
 * The current_page check (import-free, so the backend tests load it): reads the open page the backend stored
 * for this session and re-checks its path against the vault with `check` (resolve-note.ts, bound to the session
 * directory), so a hand-edited file can't point the AI outside it. Returns the text the AI sees; a missing or vanished page is a plain answer, not an error.
 */
export async function describeOpenPage(stateDir: string, sessionID: string, check: (path: string) => Promise<string>): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error('invalid session');
  const raw = await readFile(join(stateDir, `${sessionID}.json`), 'utf8').catch(() => null);
  if (raw === null) return 'No page is open: the user has no file open in the editor.';
  let page: { path?: unknown; mode?: unknown; unsaved?: unknown };
  try {
    page = JSON.parse(raw);
  } catch {
    return 'No page is open: the user has no file open in the editor.';
  }
  if (typeof page.path !== 'string') return 'No page is open: the user has no file open in the editor.';
  let path: string;
  try {
    path = await check(page.path);
  } catch {
    // A file in a visible dot dir (`.agents`) is not a note `check` accepts, but it exists and `read` reaches it: don't call it deleted.
    const segs = page.path.split('/');
    if (!page.path.startsWith('/') && segs.some((s) => s.length > 1 && s !== '..' && s.startsWith('.')) && !segs.includes('..') && !segs.includes('.git'))
      return `The user has ${page.path} open, in a dot folder that this tool does not check: read it by that path.`;
    return `The user had ${page.path} open, but it no longer exists in the vault.`;
  }
  const view = page.mode === 'read' ? 'Read mode' : 'Write mode';
  return `The user has ${path} open (${view}).${page.unsaved === true ? ' It has unsaved edits: read gives the saved text.' : ''}`;
}
