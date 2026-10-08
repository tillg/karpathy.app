import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SettingsError } from './load.js';
import type { Settings } from './schema.js';

export interface SecretUse {
  name: string;
  /** Where in the settings it is referenced, e.g. `auth.bearer_token`. */
  path: string;
  optional: boolean;
}

const isRef = (v: unknown): v is { secret: string; optional?: boolean } =>
  typeof v === 'object' && v !== null && 'secret' in v;

function walk(value: unknown, path: string, out: SecretUse[]): void {
  if (isRef(value)) {
    out.push({ name: value.secret, path, optional: value.optional === true });
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, out);
  }
}

/** The secret references the settings use: everything except gateways other than the chosen one. */
export function secretRefs(settings: Settings): SecretUse[] {
  const out: SecretUse[] = [];
  const { gateways, ...rest } = settings;
  walk(rest, '', out);
  walk(gateways[settings.ai.gateway], `gateways.${settings.ai.gateway}`, out);
  return out;
}

/** Reads each used secret from `storeDir/<name>`. Empty or missing optional secrets are undefined. */
export function resolveSecrets(settings: Settings, storeDir: string): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  const missing: string[] = [];
  for (const ref of secretRefs(settings)) {
    const file = join(storeDir, ref.name);
    const value = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : '';
    if (value) values[ref.name] = value;
    else if (!ref.optional) missing.push(`missing secret ${ref.name} (${ref.path}) in ${storeDir}`);
  }
  if (missing.length) throw new SettingsError(missing.join('\n'));
  return values;
}
