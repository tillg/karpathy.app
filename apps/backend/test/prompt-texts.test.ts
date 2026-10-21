import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prompt } from '../../../prompts/load.js';
import { startOpencode, testDir } from './opencode-container.js';

// The opencode image serves exactly the prompt files (ADR 0006): the agent prompts opencode.json pulls in with {file:}.
// Catches a missing COPY or a wrong path (the image's bake step catches one for opencode's lib/ prompts).

let oc: Awaited<ReturnType<typeof startOpencode>>;

beforeAll(async () => {
  oc = await startOpencode(join(testDir('prompt-texts'), 'vaults'));
}, 300_000);
afterAll(() => oc?.stop());

describe('prompt files in the opencode image', () => {
  it("the commit-message agent's prompt is its prompt file", async () => {
    const agents = (await (await oc.fetch(`${oc.url}/agent?directory=/vaults`)).json()) as { name: string; prompt?: string }[];
    expect(agents.find((a) => a.name === 'commit-message')!.prompt).toBe(prompt('agents/commit-message').text);
  });
});
