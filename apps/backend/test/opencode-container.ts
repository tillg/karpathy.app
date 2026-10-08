import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { loadSettings } from '@karpathy/settings';
import { basicAuth } from '../src/harness/opencode.js';

// Real opencode container for integration tests (no mocks). The vaults dir must be under the
// repo (Rancher Desktop shares /Users) and is mounted at /vaults, as in compose.
const REPO = resolve(import.meta.dirname, '../../..');
/**
 * The image built from deploy/opencode/Dockerfile, so tests load the same config and tools as prod. Tagged
 * per checkout: parallel runs in two worktrees must not overwrite each other's image (a CI prebuild under
 * another tag is still a layer-cache hit).
 */
export const IMAGE = `kai-test-opencode-${createHash('sha1').update(REPO).digest('hex').slice(0, 8)}`;
const NET = 'kai-test-net';
const OLLAMA = 'kai-test-ollama';
/** Volume that holds the Ollama models (the test models, pulled once). */
const OLLAMA_VOLUME = process.env.OLLAMA_VOLUME ?? 'kai-spike-ollama';
/** The test models: deploy/settings/test.yaml, overridable per run. */
const TEST_AI = loadSettings('test').ai;
export const LLM_MODEL = process.env.LLM_TEST_MODEL ?? TEST_AI.model;
/** A model that reads images (pulled once into the Ollama volume, like LLM_MODEL). */
export const LLM_VISION_MODEL = process.env.LLM_VISION_MODEL ?? TEST_AI.vision_model!;
/** Declared to opencode but not pulled in Ollama: every turn fails fast with a non-retryable 404. */
export const DEAD_MODEL = 'ollama/kai-no-such-model';
/** A second declared-but-not-pulled model, to observe a model switch without an LLM. */
export const DEAD_MODEL_2 = 'ollama/kai-no-such-model-2';
export const TEST_ROOT = resolve(REPO, 'tmp/test-run');

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function ensureNetwork() {
  try {
    docker('network', 'inspect', NET);
  } catch {
    // Test files run in parallel workers: another one may create it between our inspect and create.
    try {
      docker('network', 'create', NET);
    } catch (e) {
      if (!String((e as { stderr?: string }).stderr).includes('already exists')) throw e;
    }
  }
}

let built = false;
/** Builds the opencode image once per test process (layer-cached, so a no-op when nothing changed). */
function ensureImage() {
  if (built) return;
  try {
    docker('build', '-q', '-t', IMAGE, '-f', join(REPO, 'deploy/opencode/Dockerfile'), REPO);
  } catch (e) {
    // Parallel test files build the same image; the one that tags it second fails with "already exists".
    if (!String((e as { stderr?: string }).stderr).includes('already exists')) throw e;
  }
  built = true;
}

export const EGRESS = 'kai-test-egress';
/** A tiny internal HTTP server standing in for the backend: the egress proxy must refuse it. */
export const INTERNAL_TARGET = 'kai-test-target';
const EGRESS_IMAGE = 'kai-test-egress-img';
let egressBuilt = false;

/** Starts (or reuses) the egress proxy and the internal target on the test network. Returns the proxy's host port. */
export function ensureEgress(): number {
  ensureNetwork();
  if (!egressBuilt) {
    docker('build', '-q', '-t', EGRESS_IMAGE, '-f', join(REPO, 'deploy/egress/Dockerfile'), REPO);
    egressBuilt = true;
  }
  const status = (name: string) => {
    try {
      return docker('inspect', '-f', '{{.State.Status}}', name);
    } catch {
      return 'missing';
    }
  };
  const start = (name: string, ...args: string[]) => {
    // Only a dead container is replaced: any other state means another parallel worker owns it right now.
    if (!['missing', 'exited', 'dead'].includes(status(name))) return;
    if (status(name) !== 'missing') {
      try {
        docker('rm', '-f', name);
      } catch (e) {
        // Another parallel worker is removing the same dead container (first run after a Docker restart).
        if (!String((e as { stderr?: string }).stderr).includes('already in progress')) throw e;
      }
    }
    try {
      docker('run', '-d', '--name', name, '--network', NET, ...args);
    } catch (e) {
      const err = String((e as { stderr?: string }).stderr);
      if (!err.includes('is already in use') && !err.includes('removal of container')) throw e;
    }
  };
  // Waits until a container another worker may still be creating is running (CI pulls its image first).
  const running = (name: string) => {
    for (let i = 0; i < 120 && status(name) !== 'running'; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    if (status(name) !== 'running') throw new Error(`${name} is not running (${status(name)})`);
  };
  start(EGRESS, '--cap-drop', 'ALL', '-p', '127.0.0.1::3128', EGRESS_IMAGE);
  // The alpine base of the egress image (digest-pinned): a newer alpine has no httpd applet, the container exited,
  // its name stopped resolving, and the proxy answered 503 (DNS failure) instead of 403 (refused).
  const targetImage = 'alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8';
  // Pulled up front: a `docker run` that pulls leaves a window in which parallel workers race on the name.
  docker('pull', '-q', targetImage);
  start(INTERNAL_TARGET, targetImage, 'sh', '-c', 'while true; do printf "HTTP/1.1 200 OK\\r\\n\\r\\ninternal" | nc -l -p 80; done');
  running(EGRESS);
  running(INTERNAL_TARGET);
  return Number(docker('port', EGRESS, '3128/tcp').split('\n')[0]!.split(':').pop());
}

/** Starts (or reuses) the Ollama container on the test network. */
export function ensureOllama() {
  ensureNetwork();
  try {
    // "created": another parallel worker is starting it right now — don't remove it under that worker.
    if (['running', 'created'].includes(docker('inspect', '-f', '{{.State.Status}}', OLLAMA))) return;
    docker('rm', '-f', OLLAMA);
  } catch {
    // not there
  }
  try {
    // A context large enough for opencode's system prompt + the vault's AGENTS.md (#57).
    docker('run', '-d', '--name', OLLAMA, '--network', NET, '-e', 'OLLAMA_CONTEXT_LENGTH=16384', '-v', `${OLLAMA_VOLUME}:/root/.ollama`, 'ollama/ollama');
  } catch (e) {
    // Another parallel worker won the race to start it.
    if (!String((e as { stderr?: string }).stderr).includes('is already in use')) throw e;
  }
}

/**
 * Starts opencode serving `vaultsDir` at /vaults, with Ollama as provider. Use DEAD_MODEL for
 * turns that fail fast and deterministically (no LLM runs), LLM_MODEL for real ones. `env` adds container env.
 */
export async function startOpencode(vaultsDir: string, env: Record<string, string> = {}) {
  ensureImage();
  ensureOllama();
  ensureEgress();
  await mkdir(vaultsDir, { recursive: true });
  const password = randomBytes(16).toString('hex');
  const authHeader = basicAuth(password);
  const authedFetch = (input: string, init: RequestInit = {}) => fetch(input, { ...init, headers: { ...authHeader, ...(init.headers as Record<string, string> | undefined) } });
  const name = `kai-test-oc-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  // A fixed host port, so a stop/start (restart tests) keeps the URL.
  const hostPort = await freeHostPort();
  const models: Record<string, Record<string, unknown>> = Object.fromEntries(
    [LLM_MODEL, DEAD_MODEL, DEAD_MODEL_2].map((m) => m.split('/').slice(1).join('/')).map((id) => [id, { name: id, tool_call: true, limit: { context: 16384, output: 4096 } }]),
  );
  // DEAD_MODEL_2 declares image input, so the settings can be seen reporting what a model reads.
  Object.assign(models[DEAD_MODEL_2.split('/').slice(1).join('/')]!, { modalities: { input: ['text', 'image'], output: ['text'] } });
  const vision = LLM_VISION_MODEL.split('/').slice(1).join('/');
  models[vision] = { name: vision, tool_call: true, limit: { context: 16384, output: 4096 }, modalities: { input: ['text', 'image'], output: ['text'] } };
  const providerCfg = { provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: `http://${OLLAMA}:11434/v1` }, models } } };
  docker(
    'run', '-d', '--name', name, '--network', NET, '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-p', `127.0.0.1:${hostPort}:4096`,
    '-e', 'HOME=/home/app', '-e', 'XDG_DATA_HOME=/data', '-e', `OPENCODE_MODEL=${LLM_MODEL}`,
    '-e', `OPENCODE_SERVER_PASSWORD=${password}`,
    // All outbound HTTP goes through the egress proxy, as in compose; loopback and Ollama (a private IP) go direct.
    '-e', `HTTP_PROXY=http://${EGRESS}:3128`, '-e', `HTTPS_PROXY=http://${EGRESS}:3128`,
    '-e', `NO_PROXY=localhost,127.0.0.1,0.0.0.0,${OLLAMA}`,
    // A hosted model for the @llm tier (LLM_TEST_MODEL=openrouter/…): its key is passed by name only, so it
    // never shows in a command line.
    ...(process.env.OPENROUTER_API_KEY ? ['-e', 'OPENROUTER_API_KEY'] : []),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-e', `OPENCODE_CONFIG_CONTENT=${JSON.stringify(providerCfg)}`,
    '--tmpfs', `/home/app:uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000},mode=0700`,
    '--tmpfs', `/data:uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`,
    '-v', `${vaultsDir}:/vaults`,
    IMAGE, 'serve', '--hostname', '0.0.0.0', '--port', '4096',
  );
  const url = `http://127.0.0.1:${hostPort}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await authedFetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      // starting
    }
    if (Date.now() > deadline) {
      const logs = docker('logs', name);
      docker('rm', '-f', name); // don't leak it
      throw new Error(`opencode did not start: ${logs}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    url,
    name,
    /** The server password; the harness sends it as HTTP Basic auth (user `opencode`). */
    password,
    /** `fetch` with the Basic auth header, for tests that call opencode directly. */
    fetch: authedFetch,
    stop: () => void docker('rm', '-f', name),
    pause: () => void docker('stop', name),
    resume: () => void docker('start', name),
  };
}

/**
 * A free host port outside the OS's ephemeral range (49152+ on macOS). Ephemeral ports go to the tests'
 * own servers (supertest); a container port forwarded on one of them answered their requests with
 * opencode's 401/404 (flaky api tests).
 */
async function freeHostPort(): Promise<number> {
  const base = 42000;
  const start = Math.floor(Math.random() * 1000);
  for (let i = 0; i < 1000; i++) {
    const port = base + ((start + i) % 1000);
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('no free host port in 42000–42999');
}

export function testDir(label: string) {
  return join(TEST_ROOT, `${label}-${process.pid}-${Date.now()}`);
}
