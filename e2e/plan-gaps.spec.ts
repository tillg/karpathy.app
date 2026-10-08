import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, ROOT, TOKEN, expect, makeConflict, openApp, openNote, test } from './helpers';

// Verifies from the MVP plan (specs/01_mvp/plan.md, removed; see git 9c25f72) that had no e2e test yet.

test.describe('stack (plan P1)', () => {
  test('/api/health reports backend + opencode ok inside the stack', async ({ api }) => {
    const res = await api.ctx.get('/api/health');
    expect(res.status()).toBe(200);
    // built / deployed: ISO times on a release, null for local builds (the settings dialog shows them).
    const body = await res.json();
    expect(body).toEqual({ backend: 'ok', opencode: 'ok', version: expect.any(String), built: body.built, deployed: body.deployed });
    for (const t of [body.built, body.deployed]) if (t !== null) expect(Number.isNaN(Date.parse(t))).toBe(false);
  });

  test('compose ps: every service with a healthcheck is healthy; only the proxy publishes a port (and the backend its loopback debug port); opencode not reachable from the host', async () => {
    test.skip(!PROJECT, 'needs the dev stack');
    const out = execFileSync('docker', ['compose', '-p', PROJECT!, 'ps', '--format', 'json'], { encoding: 'utf8' });
    // One JSON object per line (compose v2.21+), or one array.
    const rows: { Service: string; State: string; Health: string; Publishers: { URL: string; PublishedPort: number }[] | null }[] =
      out.trim().startsWith('[') ? JSON.parse(out) : out.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.Service).sort()).toEqual(expect.arrayContaining(['backend', 'opencode', 'proxy']));
    for (const r of rows) {
      expect(r.State, r.Service).toBe('running');
      if (r.Health) expect(r.Health, r.Service).toBe('healthy');
      const published = (r.Publishers ?? []).filter((p) => p.PublishedPort > 0);
      if (r.Service === 'proxy') expect(published.length).toBeGreaterThan(0);
      else if (r.Service === 'backend') expect(published.map((p) => p.URL)).toEqual(['127.0.0.1']);
      else expect(published, r.Service).toEqual([]);
    }
    // opencode listens on 4096 inside the compose network only.
    await expect(fetch('http://127.0.0.1:4096/global/health', { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });
});

test.describe('opencode container (mvp §2.5 / §3.2)', () => {
  test.skip(!PROJECT, 'needs the dev stack');
  const inOpencode = (script: string) => execFileSync('docker', ['compose', '-p', PROJECT!, 'exec', '-T', 'opencode', 'sh', '-c', script], { encoding: 'utf8' }).trim();

  test('no git in the image (keeps subfolder confinement), HOME is a tmpfs without ~/.claude, managed config mounted, no GitHub/bearer secrets', async () => {
    expect(inOpencode('command -v git >/dev/null && echo has-git || echo no-git')).toBe('no-git');
    // /proc/mounts, not `mount`: the image's busybox `mount` prints nothing.
    expect(inOpencode('grep -c " $HOME tmpfs " /proc/mounts')).toBe('1');
    expect(inOpencode('ls -A "$HOME"').split('\n')).not.toContain('.claude');
    expect(inOpencode('cat /etc/opencode/opencode.json')).toBe(readFileSync(join(ROOT, 'deploy/opencode/opencode.json'), 'utf8').trim());
    // Only its own server password (web search change); never the GitHub or bearer token.
    expect(inOpencode('ls /run/secrets 2>/dev/null || true')).toBe('opencode_password');
    expect(inOpencode('env | grep -ciE "github|bearer" || true')).toBe('0');
    // Same UID/GID as the backend, so opencode's files stay committable.
    const uid = (svc: string) => execFileSync('docker', ['compose', '-p', PROJECT!, 'exec', '-T', svc, 'id', '-u'], { encoding: 'utf8' }).trim();
    expect(uid('opencode')).toBe(uid('backend'));
  });
});

test.describe('prod proxy config (plan P1)', () => {
  test('the prod Caddyfile (DNS-01) passes `caddy validate` in the prod proxy image', async () => {
    // The prod image carries the DNS provider module (xcaddy); use a locally built one if present.
    const images = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' }).split('\n');
    // The prod proxy image as `just prodtest` builds it (the dev stack runs stock caddy without the module).
    const image = ['ghcr.io/tillg/karpathy.app-proxy:dev'].find((i) => images.includes(i));
    test.skip(!image, 'no prod proxy image built (docker compose -f deploy/compose.yml build proxy)');
    const dir = mkdtempSync(join(tmpdir(), 'e2e-caddy-'));
    // GoDaddy credentials are `<key>:<secret>`.
    writeFileSync(join(dir, 'dns_api_token'), `${'k'.repeat(34)}:${'s'.repeat(22)}`);
    const out = execFileSync('docker', [
      'run', '--rm', '-e', 'DOMAIN=wiki.example.com', '-e', 'DNS_API_TOKEN_FILE=/run/secrets/dns_api_token',
      '-v', `${join(dir, 'dns_api_token')}:/run/secrets/dns_api_token:ro`,
      '-v', `${join(ROOT, 'deploy/proxy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      image!, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toContain('Valid configuration');
  });
});

test.describe('token handling (mvp §3.2)', () => {
  test('the bearer token never appears in a URL; /api requests carry it in the Authorization header', async ({ page, vault }) => {
    const urls: string[] = [];
    const apiWithoutHeader: string[] = [];
    page.on('request', (r) => {
      urls.push(r.url());
      if (new URL(r.url()).pathname.startsWith('/api/') && r.headers()['authorization'] !== `Bearer ${TOKEN}`) apiWithoutHeader.push(r.url());
    });
    await openApp(page, vault.id);
    await openNote(page, 'Home.md');
    await page.getByTestId('section-search').click();
    await page.getByTestId('search-input').fill('Welcome');
    await expect(page.locator('[data-testid="search-result"]').first()).toBeVisible();
    await page.getByTestId('section-changes').click();
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-messages')).toContainText('New chat');
    expect(urls.some((u) => new URL(u).pathname.startsWith('/api/vaults'))).toBe(true);
    expect(urls.filter((u) => u.includes(TOKEN) || decodeURIComponent(u).includes(TOKEN))).toEqual([]);
    expect(apiWithoutHeader).toEqual([]);
  });
});

test.describe('event stream (plan P3)', () => {
  test('tab hidden → visible reconnects the vault event stream', async ({ page, api, vault }) => {
    const opened: string[] = [];
    page.on('request', (r) => { if (r.url().includes(`/api/vaults/${vault.id}/events`)) opened.push(r.url()); });
    await openApp(page, vault.id);
    const badge = page.getByTestId('changes-badge');
    await expect(badge).toHaveAttribute('data-count', '0');
    await expect.poll(() => opened.length).toBeGreaterThan(0);
    const before = opened.length;
    const setVisibility = (state: 'hidden' | 'visible') => page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await setVisibility('hidden');
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged while hidden\n');
    await setVisibility('visible');
    await expect.poll(() => opened.length, { message: 'a new /events request after becoming visible' }).toBeGreaterThan(before);
    await expect(badge).toHaveAttribute('data-count', '1');
    // The re-opened stream is live: a further change still reaches the badge.
    await api.write(vault.id, 'Another.md', '# Another\n');
    await expect(badge).toHaveAttribute('data-count', '2');
  });
});

test.describe('chat in Conflict (plan P5)', () => {
  test('chat shows the read-only banner while the vault is in Conflict and still accepts questions', async ({ page, api, vault }) => {
    await makeConflict(api, vault);
    await openApp(page, vault.id);
    await expect(page.getByTestId('conflict-banner')).toBeVisible();
    await page.getByTestId('new-chat').click();
    const banner = page.getByTestId('chat-readonly');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('the AI can only read');
    await page.getByTestId('chat-composer').fill('What is in Home.md?');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('chat-conflict-banner.png') });
  });
});

test.describe('one running turn per vault (plan P4)', () => {
  test('@llm a prompt in a second chat shows "Waiting for other chat…" while the first chat\'s turn runs', async ({ page, vault }) => {
    test.setTimeout(10 * 60_000);
    page.on('dialog', (d) => void d.accept());
    await openApp(page, vault.id);
    // Chat A: a real (slow) model turn holds the vault's turn slot.
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-messages')).toContainText('New chat');
    await page.getByTestId('chat-composer').fill('Write a very long, detailed essay (at least 2000 words) about the history of note-taking.');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await page.getByTestId('chat-back').click();
    await expect(page.getByTestId('chat-item')).toHaveCount(1);
    // Chat B: queued behind A. Wait until B is open before typing (leaving a chat is async).
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-messages')).toContainText('New chat');
    await page.getByTestId('chat-composer').fill('Say hi.');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-queued')).toHaveText('Waiting for other chat…');
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    // Clean up: stop B, then A.
    await page.getByTestId('chat-stop').click();
    await expect(page.getByTestId('chat-queued')).toBeHidden();
    await page.getByTestId('chat-back').click();
    await page.getByTestId('chat-item').filter({ hasText: 'Write a very long' }).click();
    await expect(page.getByTestId('chat-stop').or(page.getByTestId('chat-send'))).toBeVisible({ timeout: 20_000 });
    if (await page.getByTestId('chat-stop').isVisible()) await page.getByTestId('chat-stop').click();
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 60_000 });
  });
});
