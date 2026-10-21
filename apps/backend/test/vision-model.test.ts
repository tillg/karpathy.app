import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncVisionModel, VISION_FILE } from '../src/vision-model.js';
import { visionConfig } from '../../../deploy/opencode/lib/look-at-image.js';

const read = (dir: string) => readFile(join(dir, VISION_FILE), 'utf8').then(JSON.parse, () => null);

describe('syncVisionModel', () => {
  it('writes the override without the gateway prefix, removes the file for the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-'));
    await syncVisionModel(dir, { visionModel: 'openrouter/mistralai/other', defaultVisionModel: 'openrouter/m/see', visionGateway: 'openrouter' });
    expect(await read(dir)).toEqual({ model: 'mistralai/other' });
    // The tool reads what the backend writes.
    expect((await visionConfig({ VISION_MODEL: 'm/see' }, join(dir, VISION_FILE))).model).toBe('mistralai/other');
    await syncVisionModel(dir, { visionModel: 'openrouter/m/see', defaultVisionModel: 'openrouter/m/see', visionGateway: 'openrouter' });
    expect(await read(dir)).toBeNull();
    // Removing a file that isn't there is fine.
    await syncVisionModel(dir, { visionModel: '', defaultVisionModel: '', visionGateway: '' });
  });
});
