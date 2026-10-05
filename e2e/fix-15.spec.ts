import { expect, openApp, openVaults, test } from './helpers';

// #15: adding the same repo/branch/root twice is refused with the backend's message.
test('adding a duplicate vault shows the duplicate error', async ({ page, api, vault }) => {
  await openApp(page, vault.id);
  await openVaults(page);
  await page.getByTestId('admin-open-add').click();
  await page.getByTestId('admin-name').fill('Duplicate');
  await page.getByTestId('admin-repo').fill(`e2e/${vault.name}`);
  await page.getByTestId('admin-add').click();
  await expect(page.getByTestId('admin-error')).toContainText(`already uses e2e/${vault.name}`);
  expect((await api.vaults()).filter((v) => v.repo === `e2e/${vault.name}`)).toHaveLength(1);
});
