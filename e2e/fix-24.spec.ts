import { expect, openApp, openNote, openVaults, test, typeAtEnd } from './helpers';

// #24: removing the active vault closes its note, drops its drafts and never saves into it again.
test('removing the active vault closes its note cleanly', async ({ page, api, vault }) => {
  page.on('dialog', (d) => void d.accept());
  const other = await api.createVault('rm-other');
  try {
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    await typeAtEnd(page, ' unsaved');

    await openVaults(page);
    const row = page.locator(`[data-testid="admin-vault"][data-vault="${vault.id}"]`);
    await row.click();
    await page.getByTestId('vault-details').getByTestId('vault-remove').click();
    // Back on the list once the removal is done.
    await expect(page.getByTestId('admin-open-add')).toBeVisible();
    await expect(row).toHaveCount(0);
    // From here on, any save would target the removed vault.
    const late: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes(`/vaults/${vault.id}/`)) late.push(r.url()); });
    await page.getByTestId('admin').getByRole('button', { name: 'Close', exact: true }).click();

    await expect(page.getByTestId('vault-switcher')).not.toContainText(vault.id);
    await expect(page.locator('.note-title')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain(vault.id);
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('Ideas');
    const drafts = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith(`karpathy.draft:${id}:`)), vault.id);
    expect(drafts).toEqual([]);
    await page.waitForTimeout(2500);
    expect(late.filter((u) => u.includes('/file?'))).toEqual([]);
    await expect(page.getByTestId('toast')).not.toContainText('Save failed');
  } finally {
    await api.removeVault(other.id);
  }
});
