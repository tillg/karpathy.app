import { describe, expect, it } from 'vitest';
import { loadSettings } from '../src/index.js';
import { CENTRAL, tempDir } from './helpers.js';

const load = (env: string, files: Record<string, string>) => () => loadSettings(env, { dir: tempDir({ 'settings.yaml': CENTRAL, ...files }) });

describe('schema', () => {
  it('errors name file and path', () => {
    expect(load('dev', { 'dev.yaml': 'ai: { modle: x }\n' })).toThrow(/dev\.yaml: ai\.modle/);
    expect(load('dev', { 'dev.yaml': 'timezone: 5\n' })).toThrow(/dev\.yaml: timezone/);
    expect(load('dev', { 'dev.yaml': '{}\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'files: { visible_dot_dirs: [.git] }\n' })).toThrow(/visible_dot_dirs/);
    expect(load('dev', { 'dev.yaml': 'files: { visible_dot_dirs: [agents] }\n' })).toThrow(/visible_dot_dirs/);
    expect(load('dev', { 'dev.yaml': 'auth: { bearer_token: { secret: ../x } }\n' })).toThrow(/auth\.bearer_token/);
    expect(load('staging', { 'dev.yaml': '{}\n', 'hetzner.yaml': '{}\n' })).toThrow('unknown environment staging (dev, hetzner)');
  });

  it('the central file must be complete on its own', () => {
    const dir = tempDir({ 'settings.yaml': CENTRAL.replace('timezone: Etc/UTC\n', ''), 'dev.yaml': 'timezone: Europe/Berlin\n' });
    expect(() => loadSettings('dev', { dir })).toThrow(/settings\.yaml: timezone/);
  });

  it('cross-field rules', () => {
    expect(load('dev', { 'dev.yaml': 'ai: { gateway: nope }\n' })).toThrow(/ai\.gateway: no gateway "nope"/);
    expect(load('dev', { 'dev.yaml': 'ai: { model: ollama/llama9 }\n' })).toThrow(/ai\.model: .*ollama\/small, ollama\/vision/);
    expect(load('dev', { 'dev.yaml': 'ai: { model: openrouter/z-ai/glm-5.3 }\n' })).toThrow(/ai\.model: .*gateway ollama/);
    expect(load('dev', { 'dev.yaml': 'ai: { vision_model: ollama/nope }\n' })).toThrow(/ai\.vision_model/);
    expect(load('dev', { 'dev.yaml': 'ai: { gateway: openrouter, model: openrouter/anthropic/claude-x }\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'gateways: { anthropic: { kind: anthropic, api_key: { secret: anthropic_api_key } } }\nai: { gateway: anthropic, model: anthropic/claude-x }\n' })).not.toThrow();
    expect(load('dev', { 'dev.yaml': 'proxy: { tls: dns, dns: { api_token: null } }\n' })).toThrow(/proxy\.dns\.api_token/);
  });
});
