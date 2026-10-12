import type { Plugin } from '@opencode-ai/plugin';
import { appendReport } from '../lib/md-lint.ts';

// Baked into the image (Dockerfile), never loaded from a vault. After every AI write of a .md file it lints the
// file and appends what renders broken in Obsidian to the tool result, so the model fixes it in the same turn
// (#118). Reads only; never fails the write.
export const MdLint: Plugin = async ({ directory }) => {
  console.log('md-lint ready');
  return {
    'tool.execute.after': (input, output) => appendReport(directory, input, output),
  };
};
