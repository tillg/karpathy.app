import { createApp } from './app.js';
import { ChatService } from './chat.js';
import { OpencodeCommitMessages } from './commit-message.js';
import { ConfigStore } from './config-store.js';
import { GitHubToken } from './github-token.js';
import { OpencodeHarness } from './harness/opencode.js';
import { loadBackendSettings } from './settings.js';
import { Vaults } from './vaults.js';

/** deploy/settings/, rendered by `just settings render` (compose mounts it). */
const settings = loadBackendSettings(process.env.SETTINGS_FILE ?? '/etc/karpathy/settings.json');

// Container wiring and build/deploy facts stay env: fixed per image, not chosen per environment.
const env = {
  port: Number(process.env.PORT ?? 8787),
  vaultsDir: process.env.VAULTS_DIR ?? '/vaults',
  configDir: process.env.CONFIG_DIR ?? '/config',
  opencodeUrl: process.env.OPENCODE_URL ?? 'http://opencode:4096',
  /** The vaults dir as opencode sees it (same volume, maybe another mount path). */
  opencodeVaultsDir: process.env.OPENCODE_VAULTS_DIR ?? '/vaults',
  version: process.env.APP_VERSION || 'dev',
  built: process.env.BUILT_AT || undefined,
  deployed: process.env.DEPLOYED_AT || undefined,
};

const store = await ConfigStore.open(env.configDir, { model: settings.defaultModel, webAccess: settings.webAccess, commitReminderThreshold: settings.commitReminderThreshold });
const githubToken = new GitHubToken(store, settings.githubToken, process.env.GITHUB_API_BASE);
const vaults = new Vaults(store, { vaultsDir: env.vaultsDir, remoteBase: settings.remoteBase, visibleDotDirs: settings.visibleDotDirs, githubToken: () => githubToken.current(), redact: (m) => githubToken.redact(m), identity: settings.identity });
await vaults.init();

const harness = new OpencodeHarness(env.opencodeUrl, settings.opencodePassword);
const chat = new ChatService(vaults, store, harness, env.opencodeVaultsDir);
vaults.onReady = (id) => void chat.watch(id);
vaults.beforeRemove = (id) => chat.deleteAllChats(id);
// In the background: it may wait for a restarting opencode, and the API must be up meanwhile.
void chat.init().catch((e) => console.warn('chat init:', (e as Error).message));
const commitMessages = new OpencodeCommitMessages(vaults, store, harness, (id) => chat.dir(id));

const app = createApp({ token: settings.token, vaults, store, githubToken, chat, commitMessages, opencodeHealthy: () => harness.health(), availableModels: () => harness.models(), version: env.version, built: env.built, deployed: env.deployed });
const server = app.listen(env.port, () => console.log(`backend listening on :${env.port}`));

const shutdown = () => {
  server.close();
  chat.close();
  void vaults.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
