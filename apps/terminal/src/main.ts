import { readFileSync } from 'node:fs';
import { startServer } from './server.js';
import { Terminals } from './terminals.js';

// The terminal service (#175): container wiring only, all env (deploy/compose.yml).
const token = readFileSync(process.env.TERMINAL_TOKEN_FILE ?? '/run/secrets/terminal_token', 'utf8').trim();
const port = Number(process.env.PORT ?? 8095);
/** What the shell inherits from the container; everything else (the token file's path included) stays out. */
const PASS = ['HOME', 'USER', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'DISABLE_AUTOUPDATER', 'USE_BUILTIN_RIPGREP', 'SHELL'];
const env = Object.fromEntries(PASS.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));

const terminals = new Terminals({ shell: process.env.SHELL ?? '/bin/bash', env });
const server = await startServer({ terminals, token, vaultsDir: process.env.VAULTS_DIR ?? '/vaults', port });
console.log(`terminal listening on :${port}`);

const shutdown = () => {
  terminals.closeAll();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
