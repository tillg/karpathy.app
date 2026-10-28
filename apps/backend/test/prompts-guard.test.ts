import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prompt } from '../../../prompts/load.js';

// ADR 0007 (#149): every model instruction is a prompt file in prompts/, never a string in code. Not prompt files: a tool's
// description and argument descriptions (part of its definition, next to its signature), tool output (results, errors)
// and app skills (deploy/opencode/skills/).

const REPO = join(import.meta.dirname, '../../..');
const PROMPTS = join(REPO, 'prompts');
const TOOLS = join(REPO, 'deploy/opencode/tools');
/** A string literal in single, double or back quotes. */
const LIT = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60)`;

const walk = (dir: string, ext: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) return [];
    return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
  });
const promptNames = () => walk(PROMPTS, '.md').map((p) => relative(PROMPTS, p).replace(/\.md$/, ''));
const config = () => JSON.parse(readFileSync(join(REPO, 'deploy/opencode/opencode.json'), 'utf8')) as { agent: Record<string, { prompt?: string }> };
/** Prompt files opencode.json names with {file:/opt/prompts/…} (the image path of prompts/). */
const agentRefs = () =>
  Object.values(config().agent).flatMap((a) => (a.prompt ? [/^\{file:\/opt\/prompts\/(.+)\.md\}$/.exec(a.prompt)?.[1] ?? `!${a.prompt}`] : []));

describe('prompt files (ADR 0007)', () => {
  it('tool descriptions stay in the tool code, next to the signature: no prompts/tools/, no prompt() in a tool', () => {
    expect(existsSync(join(PROMPTS, 'tools'))).toBe(false);
    expect(walk(TOOLS, '.ts').filter((f) => /\bprompt\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f))).toEqual([]);
  });

  it("every agent prompt in opencode.json is a {file:} reference to a prompt file without frontmatter", () => {
    for (const ref of agentRefs()) {
      expect(ref, 'agent prompt must be {file:/opt/prompts/<name>.md}').not.toMatch(/^!/);
      expect(readFileSync(join(PROMPTS, `${ref}.md`), 'utf8')).not.toMatch(/^---/);
    }
  });

  it('every prompt file is used', () => {
    const code = [...walk(join(REPO, 'apps'), '.ts'), ...walk(join(REPO, 'deploy/opencode'), '.ts')]
      .filter((f) => !f.includes('/test/'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const used = new Set([...code.matchAll(/\bprompt\('([\w/-]+)'\)/g)].map((m) => m[1]!).concat(agentRefs()));
    expect(promptNames().filter((n) => !used.has(n))).toEqual([]);
  });

  it('every prompt file loads', () => {
    for (const name of promptNames()) expect(() => prompt(name)).not.toThrow();
  });

  it('the backend passes no long string literal to the prompt API', () => {
    const long = walk(join(REPO, 'apps/backend/src'), '.ts').flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      const calls = String.raw`(?:promptParts|promptSync|promptAsync)\([^;]*?(${LIT})`;
      const fields = String.raw`\b(?:text|instructions|localTime)\s*:\s*(${LIT})`;
      return [...src.matchAll(new RegExp(`${calls}|${fields}`, 'g'))]
        .map((m) => m[1] ?? m[2]!)
        .filter((lit) => lit.length - 2 > 120)
        .map((lit) => `${relative(REPO, f)}: ${lit.slice(0, 60)}…`);
    });
    expect(long).toEqual([]);
  });
});
