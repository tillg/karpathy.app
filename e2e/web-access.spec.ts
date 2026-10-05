import { mkdirSync, rmSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, openApp, openSettings, test } from './helpers';

// The Web access setting (spec change web-search): a server-wide switch, on by default, and the
// chips of the AI's web calls. Settings are server-wide: the tests restore what they changed.

/** The setting is server-wide and the projects run in parallel: one test at a time may hold it. */
async function withSetting<T>(fn: () => Promise<T>): Promise<T> {
  const lock = 'tmp/web-access.lock';
  for (;;) {
    try { mkdirSync(lock); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const sw = (page: Page) => page.getByTestId('settings-web-access');

async function switchTest(page: Page, api: { settings(): Promise<{ webAccess: boolean }>; patchSettings(s: { webAccess?: boolean }): Promise<unknown> }, shot: string) {
  await withSetting(() => switchTestLocked(page, api, shot));
}
async function switchTestLocked(page: Page, api: { settings(): Promise<{ webAccess: boolean }>; patchSettings(s: { webAccess?: boolean }): Promise<unknown> }, shot: string) {
  try {
    // No patch first: whatever earlier runs left is what a fresh vault setup shows (they all restore true).
    await openApp(page);
    await openSettings(page);
    await expect(sw(page)).toBeChecked(); // 1. on by default
    await page.getByTestId('settings-dialog').screenshot({ path: `tmp/web-access/${shot}-on.png`, scale: 'css' });

    await sw(page).uncheck(); // 2. off, saved, survives a reload
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    expect((await api.settings()).webAccess).toBe(false);
    await page.reload();
    await openSettings(page);
    await expect(sw(page)).not.toBeChecked();
    await page.getByTestId('settings-dialog').screenshot({ path: `tmp/web-access/${shot}-off.png`, scale: 'css' });

    await sw(page).check(); // 3. back on
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-saved')).toBeVisible();
    expect((await api.settings()).webAccess).toBe(true);
  } finally {
    await api.patchSettings({ webAccess: true });
  }
}

test('Web access switch', async ({ page, api }) => switchTest(page, api, 'desktop'));
test('@ipad Web access switch', async ({ page, api }) => switchTest(page, api, 'ipad'));
test('@iphone Web access switch', async ({ page, api }) => switchTest(page, api, 'iphone'));

test('@llm web chips: a pasted URL shows a fetched chip that links to the page', async ({ page, api, vault, context }) => {
  test.setTimeout(15 * 60_000);
  await withSetting(() => chipsTest(page, api, vault.id, context));
});

async function chipsTest(page: Page, api: { patchSettings(s: { webAccess?: boolean }): Promise<unknown> }, vaultId: string, context: BrowserContext) {
  await api.patchSettings({ webAccess: true });
  await openApp(page, vaultId);
  await page.getByTestId('new-chat').click();
  const chip = page.locator('[data-testid="tool-chip"]', { hasText: 'fetched example.com' });
  for (const prompt of [
    'Use the webfetch tool to fetch https://example.com/ and tell me its title. Do nothing else.',
    'Call the webfetch tool now with url "https://example.com/".',
  ]) {
    if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await expect(page.getByTestId('chat-send')).toBeAttached({ timeout: 5 * 60_000 });
    if (await chip.count()) break;
  }
  await expect(chip.first()).toBeVisible();
  const link = chip.first().locator('xpath=self::a | .//a').first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.screenshot({ path: 'tmp/web-access/chip.png', scale: 'css' });
  const popup = context.waitForEvent('page');
  await link.click();
  expect((await popup).url()).toBe('https://example.com/');
}
