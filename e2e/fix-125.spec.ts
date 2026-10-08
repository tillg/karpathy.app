import { expect, openApp, test } from './helpers';

// #125: the vault switcher sits above the Files/Search/Changes picker, since those sections are scoped to the vault.
async function expectVaultAbovePicker(page: import('@playwright/test').Page) {
  const vault = await page.getByTestId('vault-switcher').boundingBox();
  const picker = await page.getByTestId('sidebar-sections').boundingBox();
  expect(vault && picker).toBeTruthy();
  expect(vault!.y + vault!.height).toBeLessThanOrEqual(picker!.y);
}

test('desktop: vault switcher above the section picker', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await expect(page.getByTestId('sidebar-sections')).toBeVisible();
  await expectVaultAbovePicker(page);
  await page.locator('#sidebar').screenshot({ path: 'tmp/fix125/desktop.png' });
});

test('@ipad tablet: vault switcher above the section picker', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-sections')).toBeVisible();
  await expectVaultAbovePicker(page);
  await page.locator('#sidebar').screenshot({ path: 'tmp/fix125/ipad.png' });
});
