import type { Locator } from '@playwright/test';
import { closeAdmin, expect, makeRemote, openApp, openSettings, openVaults, runId, test, uid } from './helpers';

/** No settings content inside the Vaults section: no Settings button, no token field, no settings group. */
async function expectNoSettings(section: Locator) {
  await expect(section.getByRole('button', { name: /settings/i })).toHaveCount(0);
  await expect(section.getByText(/GitHub token/)).toHaveCount(0);
  await expect(section.locator('.gh').filter({ hasText: /^(GitHub|App|Version)$/ })).toHaveCount(0);
}

// Admin mode keeps settings and vault management apart: the gear opens General, the vault menu opens Vaults.
test.describe('settings and vaults are separate', () => {
  test('gear opens admin mode: General has the threshold and versions, Secrets the token, AI web access, no vaults', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const general = await openSettings(page, 'general');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeFocused();
    for (const id of ['settings-threshold', 'version-server']) await expect(general.getByTestId(id)).toBeVisible();
    for (const id of ['admin-vault', 'admin-back', 'admin-open-add']) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId('token-input')).toHaveCount(0);
    await expect((await openSettings(page, 'secrets')).getByTestId('token-input')).toBeVisible();
    await expect((await openSettings(page, 'ai')).getByTestId('settings-web-access')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#admin-mode')).toBeHidden();
    // Opened from the keyboard (WebKit doesn't focus a clicked button), Escape returns focus to the gear.
    const gear = page.getByTestId('open-settings');
    await gear.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#admin-mode')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(gear).toBeFocused();
  });

  test('Manage vaults… opens Vaults: list, add, help, no settings', async ({ page, vault }) => {
    await openApp(page, vault.id);
    // Not openVaults(): the menu entry's text is checked on the way.
    await page.getByTestId('vault-switcher').filter({ visible: true }).first().click();
    await expect(page.getByTestId('manage-vaults')).not.toContainText(/settings/i);
    await page.getByTestId('manage-vaults').click();
    const section = page.getByTestId('admin-section-vaults');
    await expect(section).toBeVisible();
    await expect(section.getByTestId('admin-vault').first()).toBeVisible();
    for (const id of ['admin-open-add', 'admin-help']) await expect(section.getByTestId(id)).toBeVisible();
    await expectNoSettings(section);
  });

  test('@iphone Admin sections fit 375 px', async ({ page, vault }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openApp(page, vault.id);
    const fits = async (section: Locator, shot: string) => {
      await expect(section).toBeVisible();
      const body = page.locator('#admin-mode .admin-content');
      await expect.poll(() => body.evaluate((e) => e.scrollWidth <= e.clientWidth), { message: `${shot}: no horizontal scroll` }).toBe(true);
      const b = await section.boundingBox();
      expect(b!.x >= 0 && b!.x + b!.width <= 375 + 1, `${shot}: section inside the viewport`).toBe(true);
      await page.screenshot({ path: `tmp/settings-split/phone-${shot}.png`, scale: 'css' });
    };
    await fits(await openSettings(page, 'general'), 'settings');
    await closeAdmin(page);
    await fits(await openVaults(page), 'vaults');
  });

  test('Edit vault opens details, All vaults shows Vaults without settings', async ({ page, api }) => {
    const name = `e2e-split-${runId()}-${uid()}`;
    // As in fix-22: attach a real repo, then point it at a missing one so the vault is clone-failed.
    makeRemote(`${name}-first`);
    const broken = await api.addVault(name, `e2e/${name}-first`);
    await api.waitReady(broken.id);
    await api.ctx.patch(`/api/vaults/${broken.id}`, { data: { repo: `e2e/${name}` } });
    try {
      await expect.poll(async () => (await api.vault(broken.id)).state, { timeout: 60_000 }).toBe('clone-failed');
      await openApp(page, broken.id);
      await page.getByTestId('manage-vaults-cta').click();
      await expect(page.locator(`[data-testid="vault-details"][data-vault="${broken.id}"]`)).toBeVisible();
      await page.getByTestId('admin-back').click();
      const list = page.getByTestId('admin-section-vaults');
      await expect(list).toBeVisible();
      await expectNoSettings(list);
    } finally {
      await api.removeVault(broken.id);
    }
  });
});
