import { readFileSync } from 'node:fs';
import { loadSettings } from '@karpathy/settings';
import { describe, expect, it } from 'vitest';
import { LLM_MODEL, LLM_VISION_MODEL } from './opencode-container.js';

describe('integration test models', () => {
  it('default test models come from deploy/settings/test.yaml', () => {
    // LLM_TEST_MODEL / LLM_VISION_MODEL override them for one run (e.g. a hosted model in CI).
    const { ai } = loadSettings('test', { overlay: false });
    expect(LLM_MODEL).toBe(process.env.LLM_TEST_MODEL ?? ai.model);
    expect(LLM_VISION_MODEL).toBe(process.env.LLM_VISION_MODEL ?? ai.vision_model);
    // Read from there, not repeated as literals.
    expect(readFileSync(new URL('opencode-container.ts', import.meta.url), 'utf8')).not.toMatch(/'ollama\/qwen/);
  });
});
