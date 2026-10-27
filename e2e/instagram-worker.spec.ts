import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import { backendExec, BASE_URL, expect, openApp, openSettings, PROJECT, ROOT, runId, test, uid } from './helpers';

// Instagram in worker mode (#168): the dev stack's ingest service hands Instagram jobs to a worker
// (deploy/settings/dev.yaml, instagram_source: worker). This spec plays the worker over HTTP with the stack's worker
// token; it never contacts Instagram. The ingest service's state (workers, results) outlives the run, so every name
// and shortcode is unique per run.

const WORKER_TOKEN_FILE = resolve(ROOT, 'deploy/secrets/ingest_worker_token');
const FIXTURES = resolve(ROOT, 'e2e/fixtures/instagram');

test.beforeEach(({}, info) => {
  // Only a dev stack runs in worker mode with a worker token this checkout can read.
  test.skip(!PROJECT, 'needs a dev stack (worker mode, deploy/secrets/ingest_worker_token)');
  // The job queue and the worker list are one per stack.
  test.skip(info.project.name !== 'desktop', 'one shared job queue per stack');
});

async function workerClient(): Promise<APIRequestContext> {
  const token = readFileSync(WORKER_TOKEN_FILE, 'utf8').trim();
  return request.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/** The result a worker uploads: `post.md` and `metadata.json` of one post, gzipped flat (no directory entries). */
function buildFixture(shortcode: string): string {
  const src = mkdtempSync(join(tmpdir(), 'e2e-ig-'));
  try {
    writeFileSync(join(src, 'post.md'), `# Post ${shortcode}\n\nA caption from the e2e worker.\n`);
    writeFileSync(join(src, 'metadata.json'), JSON.stringify({ shortcode, owner: 'e2e_owner', caption: 'A caption from the e2e worker.' }));
    mkdirSync(FIXTURES, { recursive: true });
    const out = join(FIXTURES, `${shortcode}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-C', src, 'post.md', 'metadata.json']);
    return out;
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}

test('a worker claims, uploads, and the app shows it', async ({ page, api, vault }) => {
  const worker = await workerClient();
  const name = `e2e-${runId()}-${uid()}`.slice(0, 64);
  const shortcode = `e2e${uid()}`;
  const fixture = buildFixture(shortcode);
  const held: string[] = [];
  try {
    // An Input/ item whose Instagram link waits, as ingest-email leaves it (built in a dot-folder, renamed into place).
    const item = `mail-2026-10-27-${shortcode.toLowerCase()}`;
    backendExec('sh', '-c', [
      `mkdir -p /vaults/${vault.id}/Input/.tmp-${item}`,
      `printf -- '---\\ntitle: ${item}\\nunresolved_links:\\n  - url: https://www.instagram.com/p/${shortcode}/?igsh=e2e\\n    reason: worker\\n    attempts: 0\\n---\\n# ${item}\\n' > /vaults/${vault.id}/Input/.tmp-${item}/index.md`,
      `mv /vaults/${vault.id}/Input/.tmp-${item} /vaults/${vault.id}/Input/${item}`,
    ].join(' && '));

    expect((await worker.post('/api/ingest/instagram/worker/heartbeat', { data: { name, version: 'e2e', state: 'idle', message: 'configured' } })).status()).toBe(204);

    // Claim until this item's job comes up: other vaults of the stack may want older posts. Those stay leased
    // (released at the end), so they don't come back.
    let job: { id: string; url: string; leaseUntil: string } | undefined;
    for (let i = 0; i < 50 && !job; i++) {
      const res = await worker.post('/api/ingest/instagram/jobs/claim', { data: { name } });
      expect(res.status(), await res.text()).toBe(200);
      const j = await res.json();
      if (j.id === shortcode) job = j;
      else held.push(j.id);
    }
    expect(job).toMatchObject({ id: shortcode, url: `https://www.instagram.com/p/${shortcode}/` });

    expect((await worker.post('/api/ingest/instagram/worker/heartbeat', { data: { name, version: 'e2e', state: 'scraping' } })).status()).toBe(204);

    // The app shows the worker and the job in progress.
    await openApp(page, vault.id);
    const section = await openSettings(page, 'secrets');
    const row = section.locator(`[data-testid="ig-worker"][data-name="${name}"]`);
    await expect(row).toContainText(name);
    await expect(row).toContainText('Scraping');
    await expect(row).toContainText(/last seen (just now|\d+ min ago)/);
    await expect(section.getByTestId('ig-queue')).toHaveText(/^\d+ waiting · [1-9]\d* in progress · \d+ backing off · \d+ failed$/);
    await expect(section.getByTestId('ig-guide')).toHaveAttribute('href', /docs\/instagram-worker\.md$/);

    // Upload the result: stored, and a second upload is idempotent.
    const body = readFileSync(fixture);
    const put = () => worker.put(`/api/ingest/instagram/jobs/${shortcode}/result`, { data: body, headers: { 'Content-Type': 'application/gzip' } });
    expect((await put()).status()).toBe(204);
    expect((await put()).status()).toBe(204);
    expect((await worker.post('/api/ingest/instagram/worker/heartbeat', { data: { name, version: 'e2e', state: 'idle' } })).status()).toBe(204);

    // The post now waits for ingest-email (no profiles in dev, so it stays ready), not for a worker.
    const status = await (await api.ctx.get('/api/ingest/instagram')).json();
    expect(status.source).toBe('worker');
    expect(status.queue.ready).toBeGreaterThanOrEqual(1);
    expect(status.workers.find((w: { name: string }) => w.name === name)).toMatchObject({ state: 'idle', version: 'e2e' });
    // Nothing to claim for this post any more.
    const again = await worker.post('/api/ingest/instagram/jobs/claim', { data: { name } });
    if (again.status() === 200) {
      const j = await again.json();
      expect(j.id).not.toBe(shortcode);
      held.push(j.id);
    }

    await page.reload();
    const after = await openSettings(page, 'secrets');
    await expect(after.locator(`[data-testid="ig-worker"][data-name="${name}"]`)).toContainText('Idle');
  } finally {
    for (const id of held) await worker.post(`/api/ingest/instagram/jobs/${id}/release`).catch(() => undefined);
    await worker.dispose();
    rmSync(fixture, { force: true });
  }
});

test('the worker token can\'t list vaults', async () => {
  const worker = await workerClient();
  try {
    expect((await worker.get('/api/vaults')).status()).toBe(401);
    // The status and the login stay main-token only, though they share the worker routes' prefix.
    expect((await worker.get('/api/ingest/instagram')).status()).toBe(401);
    expect((await worker.post('/api/ingest/instagram/login', { data: { username: 'x', password: 'y' } })).status()).toBe(401);
    // A job route still takes it (releasing a job nobody holds is a no-op).
    expect((await worker.post(`/api/ingest/instagram/jobs/e2e${uid()}/release`)).status()).toBe(204);
  } finally {
    await worker.dispose();
  }
});
