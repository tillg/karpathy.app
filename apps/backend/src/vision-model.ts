import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ model: s.visionModel.slice(prefix.length) }));
  await rename(tmp, dest);
}
