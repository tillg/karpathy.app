import { describe, expect, it } from 'vitest';
import { loadSettings } from '../src/index.js';
import { CENTRAL, tempDir } from './helpers.js';

const load = (env: string, files: Record<string, string>) => () => loadSettings(env, { dir: tempDir({ 'settings.yaml': CENTRAL, ...files }) });

describe('schema', () => {
  it('errors name file and path', () => {
    expect(load('dev', { 'dev.yaml': 'ai: { modle: x }\n' })).toThrow(/dev\.yaml: ai\.modle/);
    expect(load('dev', { 'dev.yaml': 'timezone: 5\n' })).toThrow(/dev\.yaml: timezone/);
    expect(load('dev', { 'dev.yaml': '{}\n' })).not.toThrow();
    // No relay to a local model server any more: every model is on OpenRouter.
    expect(load('dev', { 'dev.yaml': 'gateways: { compat: { relay_upstream: host:1 } }\n' })).toThrow(/relay_upstream/);
    expect(load('dev', { 'dev.yaml': 'files: { visible_dot_dirs: [.git] }\n' })).toThrow(/visible_dot_dirs/);
    expect(load('dev', { 'dev.yaml': 'files: { visible_dot_dirs: [agents] }\n' })).toThrow(/visible_dot_dirs/);
    expect(load('dev', { 'dev.yaml': 'auth: { bearer_token: { secret: ../x } }\n' })).toThrow(/auth\.bearer_token/);
    expect(load('staging', { 'dev.yaml': '{}\n', 'hetzner.yaml': '{}\n' })).toThrow('unknown environment staging (dev, hetzner)');
  });

  it('the central file must be complete on its own', () => {
    const dir = tempDir({ 'settings.yaml': CENTRAL.replace('timezone: Etc/UTC\n', ''), 'dev.yaml': 'timezone: Europe/Berlin\n' });
    expect(() => loadSettings('dev', { dir })).toThrow(/settings\.yaml: timezone/);
  });

  it('vision_model is required', () => {
    const dir = tempDir({ 'settings.yaml': CENTRAL.replace('  vision_model: compat/vision\n', ''), 'dev.yaml': '{}\n' });
    expect(() => loadSettings('dev', { dir })).toThrow(/settings\.yaml: ai\.vision_model/);
  });

  it('title_model is optional and must be a model of ai.gateway', () => {
    expect(load('dev', { 'dev.yaml': '{}\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'ai: { title_model: compat/vision }\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'ai: { title_model: compat/nope }\n' })).toThrow(/ai\.title_model: .*compat\/small/);
    expect(load('dev', { 'dev.yaml': 'ai: { title_model: openrouter/z-ai/glm-5.3 }\n' })).toThrow(/ai\.title_model: .*gateway compat/);
  });

  it('cross-field rules', () => {
    expect(load('dev', { 'dev.yaml': 'ai: { gateway: nope }\n' })).toThrow(/ai\.gateway: no gateway "nope"/);
    expect(load('dev', { 'dev.yaml': 'ai: { model: compat/llama9 }\n' })).toThrow(/ai\.model: .*compat\/small, compat\/vision/);
    expect(load('dev', { 'dev.yaml': 'ai: { model: openrouter/z-ai/glm-5.3 }\n' })).toThrow(/ai\.model: .*gateway compat/);
    expect(load('dev', { 'dev.yaml': 'ai: { vision_model: compat/nope }\n' })).toThrow(/ai\.vision_model/);
    expect(load('dev', { 'dev.yaml': 'ai: { gateway: openrouter, model: openrouter/anthropic/claude-x, vision_model: openrouter/mistralai/m }\n' })).not.toThrow();
    // The vision model's own prefix names its gateway: switching only the chat gateway keeps the vision model valid.
    expect(load('dev', { 'dev.yaml': 'ai: { gateway: openrouter, model: openrouter/anthropic/claude-x }\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'ai: { vision_model: nowhere/m }\n' })).toThrow(/ai\.vision_model: .*no gateway "nowhere"/);
    expect(load('dev', { 'dev.yaml': 'gateways: { anthropic: { kind: anthropic, api_key: { secret: anthropic_api_key } } }\nai: { gateway: anthropic, model: anthropic/claude-x, vision_model: anthropic/claude-x }\n' })).toThrow(/ai\.vision_model: .*OpenAI-compatible/);
    expect(load('dev', { 'dev.yaml': 'proxy: { tls: dns, dns: { api_token: null } }\n' })).toThrow(/proxy\.dns\.api_token/);
  });

  it('instagram_source must be local or worker', () => {
    for (const v of ['local', 'worker'])
      expect(load('dev', { 'dev.yaml': `ingest: { defaults: { instagram_source: ${v} }, profiles: {} }\n` }), v).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'ingest: { defaults: { instagram_source: mac }, profiles: {} }\n' })).toThrow(/ingest\.defaults\.instagram_source: .*local or worker/);
  });

  it('a profile setting instagram_source is an error naming the profile', () => {
    const profile = 'p1: { vault: v, label: L, account: a@b.c, allowed_senders: [], settings: { instagram_source: worker } }';
    expect(load('dev', { 'dev.yaml': `ingest: { profiles: { ${profile} } }\n` })).toThrow(/ingest\.profiles\.p1\.settings\.instagram_source: .*ingest\.defaults/);
  });
});
