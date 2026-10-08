import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { ChatService } from './chat.js';
import { OpencodeCommitMessages } from './commit-message.js';
import { ConfigStore } from './config-store.js';
import { GitHubToken } from './github-token.js';
import { OpencodeHarness } from './harness/opencode.js';
import { Vaults } from './vaults.js';

/** Reads NAME, or the file at NAME_FILE (compose secrets). */
function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name] || undefined;
}

const env = {
  port: Number(process.env.PORT ?? 8787),
  vaultsDir: process.env.VAULTS_DIR ?? '/vaults',
  configDir: process.env.CONFIG_DIR ?? '/config',
  token: secret('BEARER_TOKEN') ?? '',
  githubToken: secret('GITHUB_TOKEN'),
  remoteBase: process.env.GIT_REMOTE_BASE ?? 'https://github.com/',
  identity: { name: process.env.GIT_AUTHOR_NAME ?? 'karpathy.app user', email: process.env.GIT_AUTHOR_EMAIL ?? 'user@karpathy.app' },
  opencodePassword: secret('OPENCODE_PASSWORD'),
  opencodeUrl: process.env.OPENCODE_URL ?? 'http://opencode:4096',
  /** The vaults dir as opencode sees it (same volume, maybe another mount path). */
  opencodeVaultsDir: process.env.OPENCODE_VAULTS_DIR ?? '/vaults',
  defaultModel: process.env.DEFAULT_MODEL,
  version: process.env.APP_VERSION || 'dev',
  built: process.env.BUILT_AT || undefined,
  deployed: process.env.DEPLOYED_AT || undefined,
};

const store = await ConfigStore.open(env.configDir, env.defaultModel ? { model: env.defaultModel } : {});
const githubToken = new GitHubToken(store, env.githubToken, process.env.GITHUB_API_BASE);
const vaults = new Vaults(store, { vaultsDir: env.vaultsDir, remoteBase: env.remoteBase, githubToken: () => githubToken.current(), redact: (m) => githubToken.redact(m), identity: env.identity });
await vaults.init();

const harness = new OpencodeHarness(env.opencodeUrl, env.opencodePassword);
const chat = new ChatService(vaults, store, harness, env.opencodeVaultsDir);
vaults.onReady = (id) => void chat.watch(id);
vaults.beforeRemove = (id) => chat.deleteAllChats(id);
// In the background: it may wait for a restarting opencode, and the API must be up meanwhile.
void chat.init().catch((e) => console.warn('chat init:', (e as Error).message));
const commitMessages = new OpencodeCommitMessages(vaults, store, harness, (id) => chat.dir(id));

const app = createApp({ token: env.token, vaults, store, githubToken, chat, commitMessages, opencodeHealthy: () => harness.health(), availableModels: () => harness.models(), version: env.version, built: env.built, deployed: env.deployed,
  ...(process.env.INGEST_URL && secret('INGEST_TOKEN') ? { ingest: { url: process.env.INGEST_URL, token: secret('INGEST_TOKEN')! } } : {}) });
const server = app.listen(env.port, () => console.log(`backend listening on :${env.port}`));

const shutdown = () => {
  server.close();
  chat.close();
  void vaults.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
