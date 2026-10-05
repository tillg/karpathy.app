import type { Locator } from '@playwright/test';
import { expect, makeRemote, openApp, openSettings, openVaults, runId, test, uid } from './helpers';

/** No settings content inside the Vaults dialog: no Settings button, no token field, no settings section. */
async function expectNoSettings(dialog: Locator) {
  await expect(dialog.getByRole('button', { name: /settings/i })).toHaveCount(0);
  await expect(dialog.getByText(/GitHub token/)).toHaveCount(0);
  await expect(dialog.locator('.gh').filter({ hasText: /^(GitHub|App|Version)$/ })).toHaveCount(0);
}

// Settings and vault management are two dialogs: the gear opens settings only, the vault menu vaults only.
test.describe('settings and vaults are separate', () => {
  test('gear opens Settings: token, app settings, version, no vaults', async ({ page, vault }) => {
    await openApp(page, vault.id);
    await openSettings(page);
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
    for (const id of ['token-input', 'settings-threshold', 'settings-web-access', 'version-server']) {
      await expect(dialog.getByTestId(id)).toBeVisible();
    }
    for (const id of ['admin-vault', 'admin-back', 'admin-open-add']) await expect(page.getByTestId(id)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Opened from the keyboard (WebKit doesn't focus a clicked button), Escape returns focus to the gear.
    const gear = page.getByTestId('open-settings');
    await gear.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(gear).toBeFocused();
  });

  test('Manage vaults… opens Vaults: list, add, help, no settings', async ({ page, vault }) => {
    await openApp(page, vault.id);
    // Not openVaults(): the menu entry's text is checked on the way.
    await page.getByTestId('vault-switcher').filter({ visible: true }).first().click();
    await expect(page.getByTestId('manage-vaults')).not.toContainText(/settings/i);
    await page.getByTestId('manage-vaults').click();
    const dialog = page.getByRole('dialog', { name: 'Vaults', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('admin-vault').first()).toBeVisible();
    for (const id of ['admin-open-add', 'admin-help']) await expect(dialog.getByTestId(id)).toBeVisible();
    await expectNoSettings(dialog);
  });

  test('@iphone Settings and Vaults dialogs fit 375 px', async ({ page, vault }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openApp(page, vault.id);
    const fits = async (dialog: Locator, shot: string) => {
      await expect(dialog).toBeVisible();
      const body = dialog.locator('.modal-body');
      await expect.poll(() => body.evaluate((e) => e.scrollWidth <= e.clientWidth), { message: `${shot}: no horizontal scroll` }).toBe(true);
      const b = await dialog.boundingBox();
      expect(b!.x >= 0 && b!.x + b!.width <= 375 + 1, `${shot}: dialog inside the viewport`).toBe(true);
      await page.screenshot({ path: `tmp/settings-split/phone-${shot}.png`, scale: 'css' });
    };
    await openSettings(page);
    await fits(page.getByTestId('settings-dialog'), 'settings');
    await page.keyboard.press('Escape');
    await openVaults(page);
    await fits(page.getByTestId('admin'), 'vaults');
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
      const list = page.getByRole('dialog', { name: 'Vaults', exact: true });
      await expect(list).toBeVisible();
      await expectNoSettings(list);
    } finally {
      await api.removeVault(broken.id);
    }
  });
});
