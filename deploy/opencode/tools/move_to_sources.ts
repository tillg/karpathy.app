import { tool } from '@opencode-ai/plugin';
import { moveToSources } from '../lib/move-to-sources.ts';

// Baked into the opencode image (Dockerfile), never loaded from a vault. Moves one ingested item from the
// ingest queue Input/ to the archive Sources/: never overwrites, never deletes. Allowed in agent vault only,
// so a read-only turn can't move.
export default tool({
  description:
    'Move one ingested source folder from Input/ to Sources/ (the ingest skill calls it after writing the wiki pages for that item). Pass the folder name only, e.g. mail-2026-10-08-xyz. It refuses an item that is still being processed (unresolved_links) and never overwrites an existing Sources/ folder.',
  args: {
    name: tool.schema.string().describe('The item folder name inside Input/, e.g. mail-2026-10-08-xyz (no slashes)'),
  },
  async execute(args, context) {
    // The moved files go in the metadata: the backend marks each as changed by the AI (harness/map.ts).
    const { output, files } = await moveToSources(context.directory, args.name);
    return { output, metadata: { files } };
  },
});
