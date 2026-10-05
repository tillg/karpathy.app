import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, rawType, type ModelInput, type Settings, type SettingsView, type TokenTest, type VaultEvent } from '@karpathy/shared';
import { bearerAuth } from './auth.js';
import { aiUnavailable, type ChatService } from './chat.js';
import { fallbackMessage, type CommitMessages } from './commit-message.js';
import type { ConfigStore } from './config-store.js';
import type { GitHubToken } from './github-token.js';
import { PathError } from './paths.js';
import { HttpError, type Vaults } from './vaults.js';

export interface AppDeps {
  token: string;
  vaults: Vaults;
  store: ConfigStore;
  githubToken?: GitHubToken;
  chat?: ChatService;
  commitMessages?: CommitMessages;
  opencodeHealthy?: () => Promise<boolean>;
  /** The models the harness can run right now (configured + credentials): `provider/model` and what they read. */
  availableModels?: () => Promise<{ id: string; input: ModelInput }[]>;
  /** Release version (APP_VERSION, baked into the image); `dev` for dev and prodtest builds. */
  version?: string;
  /** When the release's images were built (BUILT_AT, ISO 8601, set by the release workflow); unset for local builds. */
  built?: string;
  /** When the running release was deployed (DEPLOYED_AT, ISO 8601, written by Ansible); unset outside a deployment. */
  deployed?: string;
}

// Branch names reach git as arguments: only plain ref names (git check-ref-format rules),
// never anything that looks like an option (#30).
const branchName = z
  .string()
  .trim()
  .max(200)
  .refine((b) => /^[A-Za-z0-9._/-]+$/.test(b) && !/^[-/.]|\/$|\.\.|\/\.|\.lock$|\/\//.test(b), {
    error: 'Branch: use a plain branch name (letters, digits, . _ - /), e.g. main or feature/x',
  });

const addVault = z.object({
  name: z.string().trim().max(100).default(''),
  repo: z.string().trim(),
  branch: branchName.optional(),
  root: z.string().trim().max(500).optional(),
  createFolders: z.boolean().optional(),
});
const patchVault = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  repo: z.string().trim().optional(),
  branch: branchName.optional(),
  root: z.string().trim().max(500).optional(),
});
const THRESHOLD_MSG = 'Commit reminder: enter a whole number between 1 and 1000';
const patchSettings = z.object({
  commitReminderThreshold: z.number({ error: THRESHOLD_MSG }).int({ error: THRESHOLD_MSG }).min(1, { error: THRESHOLD_MSG }).max(1000, { error: THRESHOLD_MSG }).optional(),
  model: z.string().trim().regex(/^[^/\s]+\/\S+$/, { error: 'Model: use the form provider/model, e.g. anthropic/claude-sonnet-5' }).optional(),
  webAccess: z.boolean({ error: 'Web access: must be true or false' }).optional(),
});
const putFile = z.object({ content: z.string(), version: z.string().nullable(), force: z.boolean().optional() });
const commitBody = z.object({ message: z.string().min(1).max(10_000), paths: z.array(z.string()).optional() });
const resolveBody = z.object({ path: z.string().min(1), choice: z.enum(['mine', 'theirs', 'both']) });
const promptBody = z
  .object({ text: z.string().trim().max(100_000), attachments: z.array(z.string().min(1).max(1000)).max(MAX_ATTACHMENTS, { error: `At most ${MAX_ATTACHMENTS} files per message` }).optional() })
  .refine((b) => b.text.length > 0 || (b.attachments?.length ?? 0) > 0, { error: 'Write a prompt or attach a file' });

const githubTokenBody = z.object({
  token: z.string().trim().min(20, { error: 'GitHub token: that is too short to be a token' }).max(255).regex(/^\S+$/, { error: 'GitHub token: must not contain spaces' }),
});

const qs = (req: Request, name: string): string => {
  const v = req.query[name];
  if (typeof v !== 'string' || v === '') throw new HttpError(400, `query parameter ${name} is required`);
  return v;
};

/** Starts an NDJSON stream response; returns a writer. Blank lines are keepalives. */
export function ndjson(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const keepalive = setInterval(() => res.write('\n'), 15_000);
  res.on('close', () => clearInterval(keepalive));
  return {
    send: (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`),
    end: () => {
      clearInterval(keepalive);
      res.end();
    },
  };
}

export function createApp(d: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Container liveness probe only; carries no data, so it sits outside the authed /api.
  app.get('/healthz', (_req, res) => void res.send('ok'));
  const api = express.Router();
  api.use(bearerAuth(d.token));
  api.use(express.json({ limit: '10mb' }));

  api.get('/health', async (_req, res) => {
    const opencode = d.opencodeHealthy ? await d.opencodeHealthy().catch(() => false) : false;
    res.json({ backend: 'ok', opencode: opencode ? 'ok' : 'down', version: d.version ?? 'dev', built: d.built ?? null, deployed: d.deployed ?? null });
  });

  /** The harness's models, or null when it is down or doesn't answer within 3 s (the settings must still load). */
  const models = () => (d.availableModels ? Promise.race([
    d.availableModels().catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 3000).unref()),
  ]) : Promise.resolve(null));
  const settingsView = async (): Promise<SettingsView> => {
    const t = d.githubToken?.current();
    const settings = d.store.get().settings;
    const list = await models();
    const modelInput = list?.find((m) => m.id === settings.model)?.input ?? null;
    return { ...settings, githubToken: { source: d.githubToken?.source() ?? 'none', last4: t ? t.slice(-4) : null }, modelInput };
  };
  api.get('/settings', async (_req, res) => {
    res.json(await settingsView());
  });
  api.put('/settings/github-token', async (req, res) => {
    if (!d.githubToken) throw new HttpError(404, 'not available');
    await d.githubToken.set(githubTokenBody.parse(req.body).token);
    res.status(204).end();
  });
  api.post('/settings/github-token/test', async (req, res) => {
    if (!d.githubToken) throw new HttpError(404, 'not available');
    const body = z.object({ token: githubTokenBody.shape.token.optional() }).parse(req.body ?? {});
    if (body.token) d.githubToken.remember(body.token);
    const token = body.token ?? d.githubToken.current();
    const [identity, vaults] = await Promise.all([d.githubToken.identity(token), d.vaults.checkAccess(token)]);
    const result: TokenTest = { ...identity, vaults };
    res.json(result);
  });
  api.delete('/settings/github-token', async (_req, res) => {
    if (!d.githubToken) throw new HttpError(404, 'not available');
    await d.githubToken.clear();
    res.status(204).end();
  });
  api.patch('/settings', async (req, res) => {
    const body = patchSettings.parse(req.body);
    if (body.model && body.model !== d.store.get().settings.model) {
      const ids = (await models())?.map((m) => m.id);
      if (ids && !ids.includes(body.model))
        throw new HttpError(400, `Model ${body.model} is not available. Available: ${ids.join(', ') || 'none (no provider configured)'}`, 'unknown-model');
    }
    await d.store.update((c) => {
      c.settings = { ...c.settings, ...body } as Settings;
    });
    res.json(await settingsView());
  });

  // ---- vault admin ----
  api.get('/vaults', (_req, res) => {
    res.json(d.vaults.list());
  });
  api.post('/vaults', async (req, res) => {
    res.status(202).json(await d.vaults.add(addVault.parse(req.body)));
  });
  api.get('/vaults/:id', (req, res) => {
    res.json(d.vaults.getVault(req.params.id!));
  });
  api.patch('/vaults/:id', async (req, res) => {
    res.json(await d.vaults.patch(req.params.id!, patchVault.parse(req.body)));
  });
  api.delete('/vaults/:id', async (req, res) => {
    await d.vaults.remove(req.params.id!);
    d.chat?.vaultRemoved(req.params.id!);
    res.status(204).end();
  });

  // ---- status ----
  api.post('/vaults/:id/open', async (req, res) => {
    res.json(await d.vaults.open(req.params.id!));
  });
  api.get('/vaults/:id/status', async (req, res) => {
    res.json(await d.vaults.status(req.params.id!));
  });
  api.get('/vaults/:id/events', async (req, res) => {
    const id = req.params.id!;
    // Subscribe before taking the snapshot, so nothing that happens in between is lost.
    const early: VaultEvent[] = [];
    let live: ((e: VaultEvent) => void) | null = null;
    const unsub = d.vaults.subscribe(id, (e) => (live ? live(e) : early.push(e)));
    res.on('close', unsub);
    const status = await d.vaults.status(id);
    const out = ndjson(res);
    out.send({ type: 'status', status });
    for (const e of early) out.send(e);
    live = (e) => out.send(e);
  });

  // ---- files ----
  api.get('/vaults/:id/files', async (req, res) => {
    res.json(await d.vaults.listFiles(req.params.id!));
  });
  api.get('/vaults/:id/file', async (req, res) => {
    const f = await d.vaults.readFile(req.params.id!, qs(req, 'path'));
    res.setHeader('ETag', `"${f.version}"`);
    res.json(f);
  });
  api.get('/vaults/:id/raw', async (req, res, next) => {
    const path = qs(req, 'path');
    const abs = await d.vaults.rawFile(req.params.id!, path);
    const { type, attachment } = rawType(path);
    res.setHeader('Content-Type', type);
    if (attachment) res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // dotfiles: the vault's own path may contain a dot segment (rawFile already refused hidden files in `path`).
    res.sendFile(abs, { etag: false, lastModified: false, cacheControl: false, dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });
  // Upload: the body is the file's bytes; the raw parser is scoped to this route (the API is JSON elsewhere).
  api.post('/vaults/:id/raw', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const { note, source, at } = req.query;
    if ((typeof note === 'string') === (typeof source === 'string')) throw new HttpError(400, 'give exactly one of note and source', 'invalid');
    const target = typeof note === 'string' ? { note } : { source: source as string, ...(typeof at === 'string' ? { at } : {}) };
    res.status(201).json(await d.vaults.upload(req.params.id!, qs(req, 'name'), target, bytes));
  });
  api.put('/vaults/:id/file', async (req, res) => {
    const body = putFile.parse(req.body);
    res.json(await d.vaults.writeFile(req.params.id!, qs(req, 'path'), body.content, body.version, body.force));
  });
  api.delete('/vaults/:id/file', async (req, res) => {
    await d.vaults.deleteFile(req.params.id!, qs(req, 'path'), qs(req, 'version'));
    res.status(204).end();
  });
  api.get('/vaults/:id/search', async (req, res) => {
    res.json(await d.vaults.search(req.params.id!, typeof req.query.q === 'string' ? req.query.q : ''));
  });

  // ---- git ----
  api.get('/vaults/:id/changes', async (req, res) => {
    res.json(await d.vaults.changes(req.params.id!));
  });
  api.get('/vaults/:id/changes/diff', async (req, res) => {
    const path = qs(req, 'path');
    res.json({ path, diff: await d.vaults.diff(req.params.id!, path) });
  });
  api.post('/vaults/:id/discard', async (req, res) => {
    const v = req.query.version;
    await d.vaults.discard(req.params.id!, qs(req, 'path'), typeof v === 'string' ? (v === 'null' ? null : v) : undefined);
    res.status(204).end();
  });
  api.post('/vaults/:id/commit-message', async (req, res) => {
    const id = req.params.id!;
    if (!d.commitMessages) {
      return void res.json({ message: fallbackMessage((await d.vaults.changes(id)).length), fallback: true });
    }
    res.json(await d.commitMessages.propose(id));
  });
  api.post('/vaults/:id/commit', async (req, res) => {
    const b = commitBody.parse(req.body);
    res.json(await d.vaults.commit(req.params.id!, b.message, b.paths));
  });
  api.post('/vaults/:id/push', async (req, res) => {
    res.json(await d.vaults.push(req.params.id!));
  });
  api.get('/vaults/:id/conflicts/sides', async (req, res) => {
    res.json(await d.vaults.conflictSides(req.params.id!, qs(req, 'path')));
  });
  api.post('/vaults/:id/conflicts/resolve', async (req, res) => {
    const b = resolveBody.parse(req.body);
    res.json(await d.vaults.resolveConflict(req.params.id!, b.path, b.choice));
  });

  // ---- chat ----
  const chat = () => {
    if (!d.chat) throw new HttpError(503, 'chat is not available');
    return d.chat;
  };
  api.get('/vaults/:id/chats', async (req, res) => {
    res.json(await chat().list(req.params.id!));
  });
  api.post('/vaults/:id/chats', async (req, res) => {
    res.status(201).json(await chat().create(req.params.id!));
  });
  api.get('/vaults/:id/chats/:chatId', async (req, res) => {
    res.json(await chat().get(req.params.id!, req.params.chatId!));
  });
  api.delete('/vaults/:id/chats/:chatId', async (req, res) => {
    await chat().remove(req.params.id!, req.params.chatId!);
    res.status(204).end();
  });
  api.post('/vaults/:id/chats/:chatId/prompt', async (req, res) => {
    const b = promptBody.parse(req.body);
    await chat().prompt(req.params.id!, req.params.chatId!, b.text, b.attachments);
    res.status(202).json({ queued: true });
  });
  api.get('/vaults/:id/chats/:chatId/stream', async (req, res) => {
    const out = ndjson(res);
    const stop = chat().stream(req.params.id!, req.params.chatId!, (e) => out.send(e), () => out.end());
    res.on('close', stop);
  });
  api.post('/vaults/:id/chats/:chatId/abort', async (req, res) => {
    await chat().abort(req.params.id!, req.params.chatId!);
    res.status(204).end();
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    if (err instanceof PathError) return void res.status(400).json({ error: err.message, code: 'bad-path' });
    if (err instanceof z.ZodError) return void res.status(400).json({ error: err.issues.map((i) => i.message).join('; '), code: 'invalid' });
    if ((err as { type?: string }).type === 'entity.too.large') return void res.status(413).json({ error: 'The file is larger than 50 MB.', code: 'too-large' });
    if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid JSON' });
    // opencode unreachable (connection refused, reset, DNS): the AI is down, not the app.
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if ((err as Error).message === 'fetch failed' || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause ?? ''))
      return void res.status(503).json({ error: aiUnavailable().message, code: 'ai-unavailable' });
    console.error(err);
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  });

  app.use('/api', api);
  return app;
}
