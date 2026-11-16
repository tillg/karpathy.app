import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic-write.js';

/**
 * The Admin's vision model (#148), handed to opencode's `look_at_image` tool as a file on the vaults volume, outside every
 * clone: `<vaults>/.vision.json` = `{ "model": "<id without the gateway prefix>" }`. No file = the deployment's model
 * (VISION_MODEL in opencode.env). The tool reads it per call (deploy/opencode/lib/look-at-image.ts, VISION_FILE).
 */
export const VISION_FILE = '.vision.json';

/** Writes the override, or removes the file while the default applies. */
export async function syncVisionModel(vaultsDir: string, s: { visionModel: string; defaultVisionModel: string; visionGateway: string }): Promise<void> {
  const dest = join(vaultsDir, VISION_FILE);
  const prefix = `${s.visionGateway}/`;
  if (!s.visionGateway || s.visionModel === s.defaultVisionModel || !s.visionModel.startsWith(prefix)) return rm(dest, { force: true });
  await writeAtomic(dest, JSON.stringify({ model: s.visionModel.slice(prefix.length) }));
}
