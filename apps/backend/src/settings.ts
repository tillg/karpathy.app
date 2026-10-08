import { readFileSync } from 'node:fs';
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
  ai: z.strictObject({ model: z.string(), web_access: z.boolean() }),
  commit_reminder_threshold: z.number().int(),
  files: z.strictObject({
    visible_dot_dirs: z.array(z.string().regex(/^\.[^/]+$/, 'a dot-dir name starts with "."').refine((d) => d !== '.git', '.git is never shown')),
  }),
});

export interface BackendSettings {
  token: string;
  opencodePassword: string | undefined;
  githubToken: string | undefined;
  remoteBase: string;
  identity: { name: string; email: string };
  defaultModel: string;
  webAccess: boolean;
  commitReminderThreshold: number;
  visibleDotDirs: string[];
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
    webAccess: s.ai.web_access,
    commitReminderThreshold: s.commit_reminder_threshold,
    visibleDotDirs: s.files.visible_dot_dirs,
  };
}
