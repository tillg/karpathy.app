import { z } from 'zod';

/** `{ secret: name }`: which secret a setting needs, never its value. The name is a file in the secret store. */
export const secretRef = z.strictObject({
  secret: z.string().regex(/^[a-z][a-z0-9_]*$/, 'a secret name is lower-case letters, digits and _'),
  optional: z.boolean().optional(),
});
export type SecretRef = z.infer<typeof secretRef>;

/** A string setting that may also be a secret reference (e.g. a private git identity). */
const text = z.union([z.string(), secretRef]);

/** Gateway kinds whose provider opencode knows itself: `models` only adds options, any model id is valid. */
export const BUILT_IN_KINDS = ['openrouter', 'anthropic', 'openai'] as const;

const dotDir = z
  .string()
  .regex(/^\.[^/]+$/, 'a dot-dir name starts with "."')
  .refine((d) => d !== '.git', '.git is never shown');

const gateway = z.strictObject({
  kind: z.enum([...BUILT_IN_KINDS, 'openai-compatible']),
  name: z.string().optional(),
  base_url: z.string().optional(),
  /** Where the Ollama relay finds the model server (host:port), for the `ollama` gateway. */
  relay_upstream: z.string().optional(),
  api_key: secretRef.optional(),
  /** Per model: opencode's model config (options, limits, …), passed through as is. */
  models: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/**
 * One ingest profile (deploy/ingest): a Gmail label feeding one vault's Input/. `account` and `allowed_senders` may be
 * secret references (personal data stays out of this public repo); `settings` passes ingest-email options on.
 */
const ingestProfile = z.strictObject({
  vault: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a backend vault id'),
  root: z.string().optional(),
  label: z.string().min(1),
  account: text,
  /** A list, or one secret holding the whole list (comma- or newline-separated). */
  allowed_senders: z.union([z.array(text), secretRef]),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/** The settings schema: what settings.yaml and the merged result of an environment must satisfy. */
export const settingsSchema = z.strictObject({
  ai: z.strictObject({
    gateway: z.string(),
    model: z.string(),
    vision_model: z.string().optional(),
    web: z.strictObject({
      access: z.boolean(),
      fetch_cap: z.number().int().positive(),
      search_cap: z.number().int().positive(),
      exa_api_key: secretRef.optional(),
    }),
  }),
  auth: z.strictObject({ bearer_token: secretRef, opencode_password: secretRef }),
  git: z.strictObject({
    remote_base: z.string(),
    author: z.strictObject({ name: text, email: text }),
    github_token: secretRef.optional(),
  }),
  proxy: z.strictObject({
    domain: z.string(),
    tls: z.enum(['internal', 'dns']),
    dns: z.strictObject({ provider: z.string(), api_token: secretRef.nullable().optional() }),
  }),
  timezone: z.string(),
  commit_reminder_threshold: z.number().int().nonnegative(),
  files: z.strictObject({ visible_dot_dirs: z.array(dotDir) }),
  gateways: z.record(z.string(), gateway),
  /** The ingest service: which Gmail label fills which vault's Input/. No profiles = the loop idles. */
  ingest: z.strictObject({
    defaults: z.record(z.string(), z.unknown()).optional(),
    profiles: z.record(z.string(), ingestProfile),
  }).optional(),
});

/** Every object key optional, at any depth; unknown keys still rejected. Secret references stay whole. */
function deepPartial(schema: z.ZodType): z.ZodType {
  if (schema === secretRef) return schema;
  if (schema instanceof z.ZodObject)
    return z.strictObject(Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([k, v]) => [k, deepPartial(v).optional()])));
  if (schema instanceof z.ZodRecord) return z.record(z.string(), deepPartial(schema.valueType as z.ZodType));
  if (schema instanceof z.ZodOptional) return deepPartial(schema.unwrap() as z.ZodType);
  return schema;
}

/** The shape of an environment file: the same keys as settings.yaml, all optional. */
export const partialSettingsSchema = deepPartial(settingsSchema);
export type Settings = z.infer<typeof settingsSchema>;
export type Gateway = Settings['gateways'][string];

/** Rules across fields, checked on the merged settings. Returns `path: message` lines. */
export function crossFieldErrors(s: Settings): string[] {
  const errors: string[] = [];
  const gw = s.gateways[s.ai.gateway];
  if (!gw) {
    errors.push(`ai.gateway: no gateway "${s.ai.gateway}" (${Object.keys(s.gateways).join(', ')})`);
  } else {
    for (const key of ['model', 'vision_model'] as const) {
      const model = s.ai[key];
      if (model === undefined) continue;
      const prefix = `${s.ai.gateway}/`;
      const known = Object.keys(gw.models ?? {}).map((m) => prefix + m);
      if (!model.startsWith(prefix)) errors.push(`ai.${key}: ${model} is not a model of gateway ${s.ai.gateway}`);
      else if (!(BUILT_IN_KINDS as readonly string[]).includes(gw.kind) && !known.includes(model))
        errors.push(`ai.${key}: ${model} is not one of ${known.join(', ')}`);
    }
  }
  if (s.proxy.tls === 'dns' && !s.proxy.dns.api_token) errors.push('proxy.dns.api_token: required when proxy.tls is dns');
  return errors;
}
