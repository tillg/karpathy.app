import { readFileSync } from 'node:fs';

// The loader for prompt files (#149, ADR 0006): every model instruction is one .md file next to this one. Used by the
// backend (Node) and by opencode's lib/ (Bun, image path /opt/prompts), so it must stay inside prompts/ and have no
// dependency the opencode image lacks: Bun parses YAML itself, Node uses the `yaml` package.

type Parse = (src: string) => unknown;
const bunYaml = (globalThis as { Bun?: { YAML?: { parse: Parse } } }).Bun?.YAML;
const parseYaml: Parse = bunYaml ? bunYaml.parse : (await import('yaml')).parse;

export interface Prompt {
  /** The body as the model receives it (files without variables). */
  text: string;
  /** The body with every `{{variable}}` filled in; the keys must be exactly the file's `variables`. */
  render(vars: Record<string, string>): string;
}

const KEYS = new Set(['variables']);
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Loads `prompts/<name>.md` (e.g. 'local-time', 'agents/commit-message'); throws if it is missing or invalid. `base` is for tests. */
export function prompt(name: string, base: URL = new URL('./', import.meta.url)): Prompt {
  const file = `${name}.md`;
  const fail = (why: string): never => {
    throw new Error(`prompt ${file}: ${why}`);
  };
  let src: string;
  try {
    src = readFileSync(new URL(file, base), 'utf8');
  } catch {
    return fail('file not found');
  }
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
  const meta = (m ? parseYaml(m[1]!) ?? {} : {}) as Record<string, unknown>;
  const body = (m ? src.slice(m[0].length) : src).replace(/^\n+|\n+$/g, '');
  for (const k of Object.keys(meta)) if (!KEYS.has(k)) fail(`unknown frontmatter key ${k}`);
  const variables = (meta.variables ?? []) as unknown[];
  if (!Array.isArray(variables) || !variables.every((v) => typeof v === 'string')) fail('variables must be a list of names');
  const used = new Set([...body.matchAll(PLACEHOLDER)].map((p) => p[1]!));
  for (const u of used) if (!variables.includes(u)) fail(`{{${u}}} is not in variables`);
  for (const v of variables as string[]) if (!used.has(v)) fail(`variable ${v} is not used`);
  return {
    text: body,
    render(vars) {
      for (const v of variables as string[]) if (!(v in vars)) fail(`render: missing ${v}`);
      for (const k of Object.keys(vars)) if (!variables.includes(k)) fail(`render: unknown ${k}`);
      return body.replace(PLACEHOLDER, (_, v: string) => vars[v]!);
    },
  };
}
