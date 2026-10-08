import { expect, makePlainRemote, makeRemote, openApp, openSettings, openVaults, runId, test, treeItem, uid } from './helpers';

test.describe('admin area', () => {
  test('list → details → back', async ({ page, vault }) => {
    await openApp(page, vault.id);
    await openVaults(page);
    const admin = page.getByTestId('admin');
    const row = admin.locator(`[data-testid="admin-vault"][data-vault="${vault.id}"]`);
    await expect(row).toContainText(vault.name);
    await expect(row).toContainText(`e2e/${vault.name} · main`);
    await row.click();
    const details = admin.getByTestId('vault-details');
    await expect(details).toHaveAttribute('data-vault', vault.id);
    await details.getByTestId('vault-edit').click();
    await expect(details.getByTestId('edit-repo')).toHaveValue(`e2e/${vault.name}`);
    await admin.getByTestId('admin-back').click();
    await expect(row).toBeVisible();
    await expect(details).toHaveCount(0);
  });

  test('add a vault → cloned → in the switcher; edit its name; remove it', async ({ page, api }) => {
    const name = `e2e-admin-${runId()}-${uid()}`;
    makeRemote(name);
    page.on('dialog', (d) => void d.accept());
    await openApp(page);

    await openVaults(page);
    const admin = page.getByTestId('admin');
    await expect(admin).toBeVisible();
    await admin.getByTestId('admin-open-add').click();
    await page.getByTestId('admin-name').fill(name);
    await page.getByTestId('admin-repo').fill(`e2e/${name}`);
    await page.getByTestId('admin-add').click();

    const row = admin.locator(`[data-testid="admin-vault"][data-vault="${name}"]`);
    await expect(row).toBeVisible();
    // The admin list polls while cloning.
    await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });

    // Edit the display name.
    await row.click();
    const details = admin.getByTestId('vault-details');
    await details.getByTestId('vault-edit').click();
    await details.getByTestId('edit-name').fill(`${name} renamed`);
    await details.getByTestId('edit-save').click();
    await expect(details).toContainText(`${name} renamed`);
    expect((await api.vault(name)).name).toBe(`${name} renamed`);

    // Appears in the vault switcher and can be activated.
    await admin.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('vault-switcher').click();
    const opt = page.locator(`[data-testid="vault-option"][data-vault="${name}"]`);
    await expect(opt).toContainText(`${name} renamed`);
    await opt.click();
    await expect(page.getByTestId('vault-switcher')).toContainText(`${name} renamed`);
    await expect(treeItem(page, 'Home.md')).toBeVisible();

    // Remove (confirm dialog auto-accepted).
    await openVaults(page);
    await row.click();
    await details.getByTestId('vault-remove').click();
    // Back on the list once the removal is done.
    await expect(admin.getByTestId('admin-open-add')).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await api.vaults()).some((v) => v.id === name)).toBe(false);
  });

  test('an unreachable repo is refused inline and not attached', async ({ page, api }) => {
    const name = `e2e-missing-${runId()}-${uid()}`;
    await openApp(page);
    await openVaults(page);
    await page.getByTestId('admin-open-add').click();
    await page.getByTestId('admin-name').fill(name);
    await page.getByTestId('admin-repo').fill(`e2e/${name}`);
    await page.getByTestId('admin-add').click();
    await expect(page.getByTestId('admin-error')).toContainText(`Couldn't clone e2e/${name}`);
    expect((await api.vaults()).some((v) => v.id === name)).toBe(false);
  });

  test('an invalid repo name is rejected inline', async ({ page }) => {
    await openApp(page);
    await openVaults(page);
    await page.getByTestId('admin-open-add').click();
    await page.getByTestId('admin-repo').fill('not a repo');
    await page.getByTestId('admin-add').click();
    await expect(page.getByTestId('admin-error')).toContainText('owner/name');
  });

  test('missing folders: "Don\'t attach" stores nothing; "Create folders" attaches with Sources/ and Wiki/ as changes', async ({ page, api }) => {
    const name = `e2e-plain-${runId()}-${uid()}`;
    makePlainRemote(name);
    await openApp(page);
    await openVaults(page);
    const admin = page.getByTestId('admin');
    await admin.getByTestId('admin-open-add').click();
    await page.getByTestId('admin-name').fill(name);
    await page.getByTestId('admin-repo').fill(`e2e/${name}`);
    await page.getByTestId('admin-add').click();

    const ask = page.getByTestId('missing-folders');
    await expect(ask).toContainText('Sources/');
    await expect(ask).toContainText('Wiki/');
    await page.screenshot({ path: 'tmp/08/missing-folders.png' });
    await ask.getByTestId('folders-cancel').click();
    await expect(ask).toHaveCount(0);
    await expect(page.getByTestId('admin-repo')).toHaveValue(`e2e/${name}`);
    expect((await api.vaults()).some((v) => v.id === name)).toBe(false);

    await page.getByTestId('admin-add').click();
    await ask.getByTestId('folders-create').click();
    const row = admin.locator(`[data-testid="admin-vault"][data-vault="${name}"]`);
    await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    try {
      expect((await api.changes(name)).map((c) => c.path).sort()).toEqual(['Sources/.gitkeep', 'Wiki/.gitkeep']);
    } finally {
      for (const p of ['Sources/.gitkeep', 'Wiki/.gitkeep']) await api.ctx.post(`/api/vaults/${name}/discard?path=${encodeURIComponent(p)}`);
      await api.removeVault(name);
    }
  });

  test('settings: GitHub token is masked; Test token lists each vault', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await openSettings(page);
    const admin = page.getByTestId('settings-dialog');
    const input = admin.getByTestId('token-input');
    const tok = `ghp_e2e${uid()}abcdefghijklmnopqrstuv`;
    await input.fill(tok);
    await admin.getByTestId('token-save').click();
    try {
      await expect(input).toHaveValue('');
      await expect(input).toHaveAttribute('placeholder', new RegExp(`${tok.slice(-4)}$`));
      expect(JSON.stringify(await api.settings())).not.toContain(tok);
      await admin.getByTestId('token-test').click();
      const result = admin.getByTestId('token-result');
      await expect(result).toBeVisible({ timeout: 20_000 });
      await expect(result.locator(`[data-testid="token-vault"][data-vault="${vault.id}"]`)).toHaveAttribute('data-ok', 'true');
      await page.screenshot({ path: 'tmp/08/settings-token.png' });
    } finally {
      await admin.getByTestId('token-remove').click();
      await expect(input).not.toHaveAttribute('placeholder', new RegExp(`${tok.slice(-4)}$`));
    }
  });

  test('model: shows the default, an override, and goes back to the default', async ({ page, api }) => {
    const cur = await api.settings();
    // Another model the gateway offers: the refusal of an unknown one lists them.
    const refusal = await (await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { model: 'nope/none' } })).json();
    const other = String(refusal.error).replace(/.*Available: /, '').split(', ').find((m) => m !== cur.defaultModel)!;
    expect(other).toBeTruthy();
    try {
      await openApp(page);
      await openSettings(page);
      const model = page.getByTestId('settings-model');
      const hint = page.getByTestId('settings-model-default');
      await expect(hint).toHaveText(`Default: ${cur.defaultModel}`);
      await expect(hint).toHaveAttribute('data-overridden', String(cur.modelOverridden));
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
      await page.getByTestId('settings-dialog').screenshot({ path: 'tmp/settings-yaml/model-default.png' });
      expect(await api.settings()).toMatchObject({ model: cur.defaultModel, modelOverridden: false });
    } finally {
      await api.ctx.fetch('/api/settings', { method: 'PATCH', data: { model: cur.modelOverridden ? cur.model : null } });
    }
  });

  test('"What is a vault?" explains Sources and Wiki', async ({ page }) => {
    await openApp(page);
    await openVaults(page);
    await page.getByTestId('admin-help').click();
    const help = page.getByTestId('vault-help');
    await expect(help).toContainText('Sources/');
    await expect(help).toContainText('Wiki/');
    await expect(help).toContainText('Schema/');
    await help.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(help).toHaveCount(0);
    await expect(page.getByTestId('admin')).toBeVisible();
  });

  test('vault switcher switches file tree between vaults', async ({ page, api, vault }) => {
    const other = await api.createVault('switch-b');
    try {
      await api.write(other.id, 'Only-in-B.md', '# Only in B\n');
      await openApp(page, vault.id);
      await expect(treeItem(page, 'Home.md')).toBeVisible();
      await expect(treeItem(page, 'Only-in-B.md')).toHaveCount(0);

      await page.getByTestId('vault-switcher').click();
      await page.locator(`[data-testid="vault-option"][data-vault="${other.id}"]`).click();
      await expect(page.getByTestId('vault-switcher')).toContainText(other.name);
      await expect(treeItem(page, 'Only-in-B.md')).toBeVisible();

      // The choice survives a reload.
      await page.reload();
      await expect(treeItem(page, 'Only-in-B.md')).toBeVisible();
    } finally {
      await api.removeVault(other.id);
    }
  });
});
