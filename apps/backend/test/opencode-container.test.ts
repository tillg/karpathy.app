import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '@karpathy/settings';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../src/harness/map.js';
import { OpencodeHarness } from '../src/harness/opencode.js';
import { DEAD_MODEL, openrouterKey, pickTestModels, startOpencode, testDir } from './opencode-container.js';

describe('dead model', () => {
  it('a turn on it ends in error and idle within 15 s, offline, never in retry', async () => {
    // The test-only `dead` provider points at opencode's own port: no model server, no network, no key.
    expect(DEAD_MODEL).toMatch(/^dead\//);
    const vaultsDir = join(testDir('dead-model'), 'vaults');
    const oc = await startOpencode(vaultsDir);
    const harness = new OpencodeHarness(oc.url, oc.password);
    const events: HarnessEvent[] = [];
    const stop = harness.subscribe('/vaults', (e) => events.push(e));
    try {
      await new Promise((r) => setTimeout(r, 1000)); // connected
      const id = await harness.createSession('/vaults');
      const start = Date.now();
      await harness.prompt('/vaults', id, { text: 'hi', agent: 'vault-readonly', model: DEAD_MODEL });
      const mine = () => events.filter((e) => 'sessionId' in e && e.sessionId === id);
      while (!mine().some((e) => e.type === 'status' && e.state === 'idle')) {
        if (Date.now() - start > 15_000) throw new Error(`turn did not end: ${JSON.stringify(mine())}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const error = mine().find((e) => e.type === 'error');
      // The provider's HTTP answer: opencode's own 401 (its server password; about 1 s), not a config-level
      // "model not found".
      expect(error).toMatchObject({ type: 'error', message: 'Unauthorized' });
      expect(mine().some((e) => e.type === 'status' && e.state === 'retry')).toBe(false);
      // Without a test model, opencode gets the dead provider only: no model server is needed.
      const env = JSON.parse(execFileSync('docker', ['inspect', '-f', '{{json .Config.Env}}', oc.name], { encoding: 'utf8' })) as string[];
      const config = JSON.parse(env.find((e) => e.startsWith('OPENCODE_CONFIG_CONTENT='))!.split('=').slice(1).join('='));
      expect(Object.keys(config.provider)).toEqual(['dead']);
      expect(env).toContain(`OPENCODE_MODEL=${DEAD_MODEL}`);
    } finally {
      stop();
      oc.stop();
    }
  }, 120_000);
});

describe('test model choice', () => {
  // Every test runs on OpenRouter (user decision 2026-10-16): a key is required.
  const test = loadSettings('test', { overlay: false }).ai;
  const noKey = () => undefined;

  it('no key → throws with the secrets path, before any container starts', () => {
    expect(() => pickTestModels({}, { openrouterKey: noKey })).toThrow('deploy/secrets/openrouter_api_key');
  });

  it('a key → the test.yaml models (production on OpenRouter)', () => {
    expect(pickTestModels({}, { openrouterKey: () => 'k' })).toEqual({ model: test.model, vision: test.vision_model });
    expect(test.model).toMatch(/^openrouter\//);
  });

  it('LLM_TEST_MODEL wins (with a key)', () => {
    const env = { LLM_TEST_MODEL: 'openrouter/x/y', LLM_VISION_MODEL: 'openrouter/x/v' };
    expect(pickTestModels(env, { openrouterKey: () => 'k' })).toEqual({ model: 'openrouter/x/y', vision: 'openrouter/x/v' });
    expect(() => pickTestModels(env, { openrouterKey: noKey })).toThrow('deploy/secrets/openrouter_api_key');
  });

  it('the OpenRouter key comes from the env before deploy/secrets', () => {
    expect(openrouterKey({ OPENROUTER_API_KEY: 'from-env' })).toBe('from-env');
  });

  it('the test models are read from the settings, not repeated as literals', () => {
    expect(readFileSync(new URL('opencode-container.ts', import.meta.url), 'utf8')).not.toMatch(/'openrouter\/[^']*[a-z]{3}/);
  });
});
