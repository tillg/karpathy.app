import { describe, expect, it } from 'vitest';
import { environments, loadSettings } from '../src/index.js';
import { CENTRAL, tempDir } from './helpers.js';

describe('loadSettings', () => {
  it('package runs', () => {
    expect(typeof loadSettings).toBe('function');
  });

  it('maps merge, scalars and lists replace', () => {
    const dir = tempDir({
      'settings.yaml': CENTRAL,
      'dev.yaml': 'ai: { model: ollama/vision, web: { search_cap: 5 } }\nfiles: { visible_dot_dirs: [.obsidian] }\n',
    });
    const s = loadSettings('dev', { dir });
    expect(s.ai.model).toBe('ollama/vision');
    expect(s.ai.gateway).toBe('ollama');
    expect(s.ai.web).toEqual({ access: true, fetch_cap: 20, search_cap: 5, exa_api_key: { secret: 'exa_api_key', optional: true } });
    expect(s.files.visible_dot_dirs).toEqual(['.obsidian']);
    expect(environments(dir)).toEqual(['dev']);
  });

  it('a secret reference replaces as a whole', () => {
    const dir = tempDir({ 'settings.yaml': CENTRAL, 'hetzner.yaml': 'git: { github_token: { secret: gh } }\n' });
    expect(loadSettings('hetzner', { dir }).git.github_token).toEqual({ secret: 'gh' });
  });

  it('dev.local.yaml overlays dev, never a target', () => {
    const dir = tempDir({
      'settings.yaml': CENTRAL,
      'dev.yaml': 'timezone: Europe/Berlin\n',
      'dev.local.yaml': 'ai: { gateway: openrouter, model: openrouter/z-ai/glm-5.3 }\n',
      'hetzner.yaml': 'timezone: Europe/Berlin\n',
      'prodtest.yaml': 'timezone: Europe/Berlin\n',
    });
    expect(loadSettings('dev', { dir }).ai.model).toBe('openrouter/z-ai/glm-5.3');
    expect(loadSettings('prodtest', { dir }).ai.model).toBe('ollama/small');
    expect(loadSettings('hetzner', { dir }).ai.model).toBe('ollama/small');
    expect(environments(dir)).toEqual(['dev', 'hetzner', 'prodtest']);
    const bad = tempDir({ 'settings.yaml': CENTRAL, 'hetzner.yaml': '{}\n', 'hetzner.local.yaml': 'timezone: X\n' });
    expect(() => loadSettings('hetzner', { dir: bad })).toThrow(/local overlays apply to dev and prodtest only/);
  });
});
