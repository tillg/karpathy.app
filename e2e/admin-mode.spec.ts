import { expect, openApp, openSettings, openSection, test, type AdminSection } from './helpers';

// Admin mode (#150), section by section: heading, behaviour, and a 1x screenshot of each into tmp/admin-mode/.
const SECTIONS: { id: AdminSection; heading: string }[] = [
  { id: 'general', heading: 'General' },
  { id: 'vaults', heading: 'Vaults' },
  { id: 'secrets', heading: 'Secrets & keys' },
  { id: 'ai', heading: 'AI' },
  { id: 'usage', heading: 'Usage' },
  { id: 'server', heading: 'Server' },
];

// Chromium desktop runs the untagged copy, the iPhone project the @iphone one (rail vs. section list).
for (const tag of ['', ' @iphone']) {
  test(`every section opens from the rail (desktop) and from the list (iphone) and shows its heading${tag}`, async ({ page, vault }) => {
    const phone = tag !== '';
    await openApp(page, vault.id);
    await openSettings(page, 'general');
    if (phone) await expect(page.getByTestId('admin-row-server')).toHaveCount(0); // inside a section: no list
    for (const s of SECTIONS) {
      const section = await openSection(page, s.id);
      await expect(page.getByRole('heading', { name: s.heading, exact: true })).toBeVisible();
      await expect(section).toBeVisible();
      // Phone: the large title sits at the content's left edge (16 px), not indented by the list's 20 px margin.
      if (phone) expect((await section.getByRole('heading', { name: s.heading, exact: true }).boundingBox())!.x).toBeLessThanOrEqual(21);
      await expect(page.locator('#admin-mode')).toHaveClass(phone ? /phone/ : /^(?!.*phone)/);
    }
  });

  test(`screenshots of every section at 1x${tag}`, async ({ page, vault }, info) => {
    await openApp(page, vault.id);
    await openSettings(page, 'general');
    const shot = async (name: string) => {
      const body = page.locator('#admin-mode .admin-content');
      await body.evaluate((e) => { e.scrollTop = 0; });
      await page.screenshot({ path: `tmp/admin-mode/${info.project.name}-${name}.png`, scale: 'css' });
      // Bottom of the page: the last rows of long sections.
      await body.evaluate((e) => { e.scrollTop = e.scrollHeight; });
      await page.screenshot({ path: `tmp/admin-mode/${info.project.name}-${name}-end.png`, scale: 'css' });
      await expect.poll(() => body.evaluate((e) => e.scrollWidth <= e.clientWidth), { message: `${name}: no horizontal scroll` }).toBe(true);
    };
    for (const s of SECTIONS) {
      await openSection(page, s.id);
      // Wait for the data, not the "Loading…" line: Server shows chart cards, Usage its tiles.
      if (s.id === 'server') await expect(page.locator('#admin-mode .chart-card').first()).toBeVisible({ timeout: 70_000 });
      if (s.id === 'usage') await expect(page.locator('#admin-mode .tiles').first()).toBeVisible();
      await shot(s.id);
    }
    if (tag) {
      await page.locator('#admin-mode header .back').click();
      await expect(page.getByTestId('admin-row-general')).toBeVisible();
      await page.screenshot({ path: `tmp/admin-mode/${info.project.name}-list.png`, scale: 'css' });
      const list = page.locator('#admin-mode .admin-content, #admin-mode main').first();
      await list.evaluate((e) => { e.scrollTop = e.scrollHeight; });
      await page.screenshot({ path: `tmp/admin-mode/${info.project.name}-list-end.png`, scale: 'css' });
    }
  });
}

// Both change the server-wide settings (Save sends every AI field): one after the other.
test.describe('AI settings', () => {
  test.describe.configure({ mode: 'serial' });

  test('AI: the model field, Use default and Web access behave as in the old Settings dialog', async ({ page, api }) => {
    const cur = await api.settings() as Awaited<ReturnType<typeof api.settings>> & { defaultModel: string; modelOverridden: boolean };
    const refusal = await (await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { model: 'nope/none' } })).json();
    const other = String(refusal.error).replace(/.*Available: /, '').split(', ').find((m) => m !== cur.defaultModel)!;
    expect(other).toBeTruthy();
    try {
      await openApp(page);
      await openSettings(page, 'ai');
      const model = page.getByTestId('settings-model');
      const hint = page.getByTestId('settings-model-default');
      await expect(hint).toHaveText(`Default: ${cur.defaultModel}`);
      await model.fill(other);
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('settings-saved')).toBeVisible();
      await expect(hint).toHaveAttribute('data-overridden', 'true');
      expect(await api.settings()).toMatchObject({ model: other, modelOverridden: true });
      await page.getByTestId('settings-model-reset').click();
      await expect(model).toHaveValue(cur.defaultModel);
      await page.getByTestId('settings-save').click();
      await expect(hint).toHaveAttribute('data-overridden', 'false');
      await expect(page.getByTestId('settings-model-reset')).toHaveCount(0);
      // Web access: toggle, save, the backend has it.
      const web = page.getByTestId('settings-web-access');
      const before = await web.isChecked();
      await web.setChecked(!before);
      await page.getByTestId('settings-save').click();
      await expect.poll(async () => (await api.settings()).webAccess).toBe(!before);
    } finally {
      await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { model: cur.modelOverridden ? cur.model : null, webAccess: cur.webAccess } });
    }
  });

  test('AI: title model and vision model show their defaults, save an override and go back with Use default (#148)', async ({ page, api }, info) => {
    // Server-wide settings: a second browser project running it at the same time would reset them under this one.
    test.skip(info.project.name !== 'desktop', 'runs in the desktop project only');
    type View = Awaited<ReturnType<typeof api.settings>> & { titleModel: string; defaultTitleModel: string; titleModelOverridden: boolean; visionModel: string; defaultVisionModel: string; visionModelOverridden: boolean; visionGateway: string };
    const cur = await api.settings() as View;
    const refusal = await (await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { titleModel: 'nope/none' } })).json();
    expect(String(refusal.error)).toMatch(/Title model nope\/none is not available/);
    const other = String(refusal.error).replace(/.*Available: /, '').split(', ').find((m) => m !== cur.defaultTitleModel)!;
    const otherVision = `${cur.visionGateway}/some-other-vision-model`;
    try {
      await openApp(page);
      await openSettings(page, 'ai');
      const title = page.getByTestId('settings-title-model');
      const vision = page.getByTestId('settings-vision-model');
      await expect(title).toHaveValue(cur.defaultTitleModel);
      await expect(vision).toHaveValue(cur.defaultVisionModel);
      await expect(page.getByTestId('settings-title-model-default')).toHaveText(`Default: ${cur.defaultTitleModel || 'the chat model'}`);
      await expect(page.getByTestId('settings-vision-model-default')).toHaveText(`Default: ${cur.defaultVisionModel}`);
      await title.fill(other);
      await vision.fill(otherVision);
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('settings-saved')).toBeVisible();
      expect(await api.settings()).toMatchObject({ titleModel: other, titleModelOverridden: true, visionModel: otherVision, visionModelOverridden: true });
      await page.getByTestId('settings-title-model-reset').click();
      await page.getByTestId('settings-vision-model-reset').click();
      await expect(title).toHaveValue(cur.defaultTitleModel);
      await expect(vision).toHaveValue(cur.defaultVisionModel);
      await page.getByTestId('settings-save').click();
      await expect.poll(async () => (await api.settings()) as View).toMatchObject({ titleModelOverridden: false, visionModelOverridden: false });
      await expect(page.getByTestId('settings-title-model-reset')).toHaveCount(0);
    } finally {
      await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { titleModel: cur.titleModelOverridden ? cur.titleModel : null, visionModel: cur.visionModelOverridden ? cur.visionModel : null } });
    }
  });
});

test('Secrets: the dev stack\'s secrets show Set', async ({ page }) => {
  await openApp(page);
  const section = await openSettings(page, 'secrets');
  const row = (name: string) => section.getByTestId('secret-row').filter({ hasText: name });
  for (const name of ['bearer_token', 'opencode_password']) await expect(row(name).locator('.status')).toHaveText(/Set$/);
  for (const name of ['exa_api_key', 'github_token', 'dns_api_token']) await expect(row(name).locator('.status')).toHaveText(/Not set \(optional\)$/);
  // The pills are pills: "Not set (optional)" has its own background, like "Set".
  const bg = (name: string) => row(name).locator('.status').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await bg('exa_api_key')).not.toBe('rgba(0, 0, 0, 0)');
});

test('Server: CPU sparkline appears after the first sample', async ({ page }) => {
  await openApp(page);
  const section = await openSettings(page, 'server');
  const cpu = section.locator('.chart-card').filter({ hasText: 'CPU' });
  // The sampler's first sample comes within 30 s of the backend start; the section polls every 30 s.
  await expect(cpu.locator('svg.chart path.line')).toBeVisible({ timeout: 70_000 });
  await expect(cpu.locator('.cur')).toContainText('%');
  await expect(section.getByText('AI harness (opencode)')).toBeVisible();
});

test('@llm Usage: after one chat turn today\'s bar is non-zero', async ({ page, vault }) => {
  test.setTimeout(15 * 60_000);
  await openApp(page, vault.id);
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await page.getByTestId('new-chat').click();
  await page.getByTestId('chat-composer').fill('Say hello in one word.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 8 * 60_000 });
  await expect(page.getByTestId('context-meter')).toHaveText(/\d/, { timeout: 30_000 });

  const section = await openSettings(page, 'usage');
  // Today is the last day of the chart: its stack has a segment with height.
  const today = section.locator('svg.chart g.stack').last();
  await expect.poll(async () => (await today.locator('rect.seg').evaluateAll((rs) => rs.reduce((n, r) => n + Number(r.getAttribute('height')), 0))), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(section.locator('.tile').first().locator('.v')).not.toHaveText('0');
  // This test's own vault: its one chat counts, with tokens (not only the other vaults' chats).
  const mine = section.locator('tr').filter({ hasText: vault.name });
  await expect(mine.locator('td').nth(1)).toHaveText('1');
  await expect(mine.locator('td').nth(2)).not.toHaveText('0');
});

test('@iphone Usage and Server on the phone: chart labels stay readable, the range line is not cut', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const usage = await openSettings(page, 'usage');
  // The day labels of the bar chart: at least 10 px tall on screen (a scaled-down 700-wide SVG made them ~5 px).
  const label = usage.locator('svg.chart g.stack text').first();
  await expect(label).toBeVisible();
  await expect.poll(async () => (await label.boundingBox())!.height).toBeGreaterThanOrEqual(10);
  const server = await openSection(page, 'server');
  await expect(server.locator('.chart-card').first()).toBeVisible({ timeout: 70_000 });
  // "sampled every 30 s · updated N s ago" is shown in full, inside the screen.
  const line = server.locator('.row-h .muted').first();
  await expect(line).toContainText('updated');
  const fits = await line.evaluate((e) => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right <= window.innerWidth);
  expect(fits).toBe(true);
});

test('@iphone Usage: the numeric column headers of the tables do not run together', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const section = await openSettings(page, 'usage');
  const heads = section.locator('table.tbl').first().locator('th');
  await expect(heads.first()).toBeVisible();
  const boxes = await heads.evaluateAll((hs) => hs.map((h) => { const r = h.getBoundingClientRect(); return [r.left, r.right]; }));
  // The text of one header ends well before the next one starts: compare the cells' content boxes.
  const gaps = await heads.evaluateAll((hs) => hs.slice(1).map((h, i) => {
    const range = document.createRange();
    range.selectNodeContents(hs[i]!);
    const prev = range.getBoundingClientRect().right;
    range.selectNodeContents(h);
    return range.getBoundingClientRect().left - prev;
  }));
  expect(boxes.length).toBeGreaterThan(2);
  for (const g of gaps) expect(g).toBeGreaterThanOrEqual(6);
});
