import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { crossFieldErrors, partialSettingsSchema, settingsSchema, type Settings } from './schema.js';

/** The settings directory of this checkout: deploy/settings/. */
export const SETTINGS_DIR = new URL('../../../deploy/settings/', import.meta.url).pathname;

/** Environments that may have a gitignored `<env>.local.yaml` overlay. */
const OVERLAY_ENVS = ['dev', 'prodtest'];

export class SettingsError extends Error {}

/** The environments: every `<env>.yaml` in `dir` except `settings.yaml` and `*.local.yaml`. */
export function environments(dir = SETTINGS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== 'settings.yaml' && !f.endsWith('.local.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

function readYaml(file: string, schema: z.ZodType, label: string): Record<string, unknown> {
  const data: unknown = parse(readFileSync(file, 'utf8')) ?? {};
  const result = schema.safeParse(data);
  if (!result.success) throw new SettingsError(result.error.issues.map((i) => describe(label, i)).join('\n'));
  return data as Record<string, unknown>;
}

/** `file: a.b.c: message`; an unknown key is named in the path itself. */
function describe(label: string, issue: z.core.$ZodIssue): string {
  const path = [...issue.path, ...(issue.code === 'unrecognized_keys' ? [issue.keys.join(', ')] : [])].join('.');
  return `${label}: ${path}: ${issue.message}`;
}

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !('secret' in v);

/** Maps merge key by key; scalars, lists and secret references replace. */
export function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isMap(out[k]) && isMap(v) ? merge(out[k], v) : v;
  return out;
}

/**
 * The effective settings of `env`: settings.yaml ← <env>.yaml ← <env>.local.yaml (dev, prodtest).
 * `local: false` skips the developer's overlay (tests of the committed files).
 */
export function loadSettings(env: string, { dir = SETTINGS_DIR, local: useLocal = true }: { dir?: string; local?: boolean } = {}): Settings {
  const envs = environments(dir);
  if (!envs.includes(env)) throw new SettingsError(`unknown environment ${env} (${envs.join(', ')})`);
  let data = readYaml(join(dir, 'settings.yaml'), settingsSchema, 'settings.yaml');
  data = merge(data, readYaml(join(dir, `${env}.yaml`), partialSettingsSchema, `${env}.yaml`));
  const local = join(dir, `${env}.local.yaml`);
  if (useLocal && existsSync(local)) {
    if (!OVERLAY_ENVS.includes(env))
      throw new SettingsError(`${env}.local.yaml: local overlays apply to dev and prodtest only`);
    data = merge(data, readYaml(local, partialSettingsSchema, `${env}.local.yaml`));
  }
  const settings = settingsSchema.safeParse(data);
  if (!settings.success)
    throw new SettingsError(settings.error.issues.map((i) => describe(`${env} (merged)`, i)).join('\n'));
  const errors = crossFieldErrors(settings.data);
  if (errors.length) throw new SettingsError(errors.map((e) => `${env}: ${e}`).join('\n'));
  return settings.data;
}
