import { breakRemote, expect, openApp, openNote, pushFromObsidian, test } from './helpers';
import type { Page } from '@playwright/test';

/**
 * The event stream reconnects when the page becomes visible, and each connect makes the backend
 * fetch. A reload would not do: the open's pull would take the commits in first.
 */
const reconnect = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/**
 * Reconnects until `check` passes: a connect while a fetch runs joins that fetch, which may have
 * started before the push (or before the remote broke).
 */
const reconnectUntil = (page: Page, check: () => Promise<void>) =>
  expect(async () => {
    await reconnect(page);
    await check();
  }).toPass({ timeout: 20_000 });

test.describe('incoming changes from GitHub', () => {
  test('an Obsidian push shows as incoming; one tap brings it in', async ({ page, vault }) => {
    await openApp(page, vault.id);
    await openNote(page, 'Home.md');
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas v2\n\nBack to [[Home]].\n', 'one');
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas v3\n\nBack to [[Home]].\n', 'two');
    const badge = page.getByTestId('incoming-badge');
    await reconnectUntil(page, () => expect(badge).toHaveText('· 1 incoming', { timeout: 2000 }));
    await expect(badge).toHaveAccessibleName('Pull 1 incoming change from GitHub');
    await expect(page.getByTestId('changes-badge')).toContainText('All committed');
    await page.screenshot({ path: test.info().outputPath('incoming-pill.png') });
    await badge.click();
    await expect(page.getByTestId('toast')).toContainText('Pulled 1 change from GitHub');
    await expect(badge).toBeHidden();
    await openNote(page, 'Ideas.md');
    await expect(page.locator('.cm-content')).toContainText('Ideas v3');
  });

  test("the open note shows 'Changed on GitHub · Pull' and stays editable", async ({ page, vault }) => {
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas from Obsidian\n\nBack to [[Home]].\n');
    const bar = page.getByTestId('incoming-note');
    await reconnectUntil(page, () => expect(bar).toBeVisible({ timeout: 2000 }));
    await expect(bar).toContainText('Changed on GitHub');
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    await page.screenshot({ path: test.info().outputPath('incoming-note.png') });
    await bar.getByRole('button', { name: /pull/i }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator('.cm-content')).toContainText('Ideas from Obsidian');
    // A push to another file: counted, but no bar on this note.
    pushFromObsidian(vault.bare, 'Home.md', '# Home from Obsidian\n');
    await reconnectUntil(page, () => expect(page.getByTestId('incoming-badge')).toHaveText('· 1 incoming', { timeout: 2000 }));
    await expect(bar).toBeHidden();
  });

  test('Changes panel lists incoming files', async ({ page, vault }) => {
    await openApp(page, vault.id);
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas from Obsidian\n');
    pushFromObsidian(vault.bare, 'Home.md', '# Home from Obsidian\n');
    await page.getByTestId('section-changes').click();
    await reconnectUntil(page, () => expect(page.getByTestId('incoming')).toHaveText('2 incoming changes · pull', { timeout: 2000 }));
    const list = page.getByTestId('incoming-list');
    await expect(list).toContainText('Ideas.md');
    await expect(list).toContainText('Home.md');
    await list.getByText('Ideas.md').click();
    await expect(page.getByTestId('diff')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('incoming-list.png') });
  });

  test('tapping incoming with a clashing local edit ends in conflict', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await api.write(vault.id, 'Ideas.md', '# Ideas mine\n\nBack to [[Home]].\n');
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas theirs\n\nBack to [[Home]].\n');
    await reconnectUntil(page, () => expect(page.getByTestId('incoming-badge')).toBeVisible({ timeout: 2000 }));
    await page.getByTestId('incoming-badge').click();
    await expect(page.getByTestId('changes-badge')).toHaveText(/Conflict/);
    await expect(page.getByTestId('conflict-banner')).toBeVisible();
    await expect(page.getByTestId('incoming-badge')).toBeHidden();
    expect((await api.status(vault.id)).state).toBe('conflict');
  });

  test('offline fetch keeps the count', async ({ page, vault }) => {
    await openApp(page, vault.id);
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas from Obsidian\n');
    const badge = page.getByTestId('incoming-badge');
    await reconnectUntil(page, () => expect(badge).toHaveText('· 1 incoming', { timeout: 2000 }));
    const restore = breakRemote(vault.bare);
    try {
      await reconnectUntil(page, () => expect(page.getByTestId('changes-badge')).toContainText('· offline', { timeout: 2000 }));
      await expect(badge).toHaveText('· 1 incoming');
      await badge.click();
      await expect(page.getByTestId('toast')).toContainText("Couldn't reach GitHub");
      await expect(badge).toHaveText('· 1 incoming');
    } finally {
      restore();
    }
  });

  test('@iphone phone: tab badge ↓ and Changes panel pull', async ({ page, vault }) => {
    await openApp(page, vault.id);
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas from Obsidian\n');
    const tab = page.getByTestId('changes-badge-tab');
    await reconnectUntil(page, () => expect(tab).toHaveText('↓', { timeout: 2000 }));
    await page.getByTestId('tab-changes').click();
    const banner = page.getByTestId('incoming');
    await expect(banner).toHaveText('1 incoming change · pull');
    await page.screenshot({ path: test.info().outputPath('incoming-phone.png') });
    await banner.getByRole('button', { name: /pull/i }).click();
    await expect(banner).toBeHidden();
    await expect(tab).toBeHidden();
  });
});
