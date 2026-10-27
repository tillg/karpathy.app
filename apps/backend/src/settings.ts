import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/** A secret as a file, e.g. a compose secret at /run/secrets/<name>. */
const file = z.strictObject({ file: z.string() });

/**
 * The backend's settings.json, rendered from deploy/settings/ by `just settings render`
 * (packages/settings, renderBackendSettings). Its tests parse their output with this schema.
 */
export const backendSettingsSchema = z.strictObject({
  auth: z.strictObject({ bearer_token: file, opencode_password: file }),
  git: z.strictObject({
    remote_base: z.string(),
    author: z.strictObject({ name: z.string(), email: z.string() }),
    github_token: file.optional(),
  }),
  /** `title_model` and the vision fields are absent in an older settings.json. */
  ai: z.strictObject({
    model: z.string(),
    title_model: z.string().optional(),
    vision_model: z.string().optional(),
    vision_gateway: z.string().optional(),
    web_access: z.boolean(),
  }),
  commit_reminder_threshold: z.number().int(),
  files: z.strictObject({
    visible_dot_dirs: z.array(z.string().regex(/^\.[^/]+$/, 'a dot-dir name starts with "."').refine((d) => d !== '.git', '.git is never shown')),
  }),
  /** The Instagram worker's token (#168); absent in an older settings.json. */
  ingest: z.strictObject({ worker_token: file.optional() }).optional(),
  /** The secret manifest (names and booleans only), as of the render; absent in an older settings.json. */
  secrets: z
    .array(z.strictObject({ name: z.string(), component: z.string(), purpose: z.string(), optional: z.boolean(), set: z.boolean() }))
    .default([]),
});

export interface BackendSettings {
  token: string;
  opencodePassword: string | undefined;
  githubToken: string | undefined;
  remoteBase: string;
  identity: { name: string; email: string };
  defaultModel: string;
  /** '' = the chat model in effect. */
  defaultTitleModel: string;
  /** `<vision gateway>/<model>`; '' in an older settings.json. */
  defaultVisionModel: string;
  visionGateway: string;
  webAccess: boolean;
  commitReminderThreshold: number;
  visibleDotDirs: string[];
  secrets: z.infer<typeof backendSettingsSchema>['secrets'];
  /** Accepted on the Instagram worker routes only; undefined = only the main token works there. */
  workerToken: string | undefined;
}

const secret = (f: { file: string } | undefined) => (f ? readFileSync(f.file, 'utf8').trim() || undefined : undefined);

/** Reads settings.json and the secret files it points at; throws with the path on any problem. */
export function loadBackendSettings(path: string): BackendSettings {
  let s: z.infer<typeof backendSettingsSchema>;
  try {
    s = backendSettingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (e as Error).message;
    throw new Error(`settings ${path}: ${msg}`, { cause: e });
  }
  return {
    token: secret(s.auth.bearer_token) ?? '',
    opencodePassword: secret(s.auth.opencode_password),
    githubToken: secret(s.git.github_token),
    remoteBase: s.git.remote_base,
    identity: s.git.author,
    defaultModel: s.ai.model,
    defaultTitleModel: s.ai.title_model ?? '',
    defaultVisionModel: s.ai.vision_model && s.ai.vision_gateway ? `${s.ai.vision_gateway}/${s.ai.vision_model}` : '',
    visionGateway: s.ai.vision_gateway ?? '',
    webAccess: s.ai.web_access,
    commitReminderThreshold: s.commit_reminder_threshold,
    visibleDotDirs: s.files.visible_dot_dirs,
    secrets: s.secrets,
    // Optional: a stack without the secret file still starts, with the worker routes on the main token only.
    workerToken: s.ingest?.worker_token && existsSync(s.ingest.worker_token.file) ? secret(s.ingest.worker_token) : undefined,
  };
}
