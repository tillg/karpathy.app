import { tool } from '@opencode-ai/plugin';
import { describeOpenPage, OPEN_PAGE_DIR } from '../lib/open-page.ts';
import { resolveNote } from '../lib/resolve-note.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. It reads no vault file: the backend leaves
// the open page of the chat on the shared volume when the prompt arrives (apps/backend/src/open-page.ts).
export default tool({
  description:
    'Tell which file the user has open in the editor right now. Call it when the user says "this note", "this page", "this file", "here" or otherwise means what they are looking at, then use read on the path it returns. It returns the vault-relative path (or says that nothing is open); it does not return the content.',
  args: {},
  async execute(_args, context) {
    return describeOpenPage(OPEN_PAGE_DIR, context.sessionID, (path) => resolveNote(context.directory, path));
  },
});
