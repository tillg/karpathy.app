import { expect, openApp, openSettings, test } from './helpers';

// #16: settings show "Saved", reject bad input with human-readable messages and unknown models.
// Settings are server-wide: the test only saves the current values, and restores them regardless.
test('settings: saved feedback, readable validation errors, unknown model refused', async ({ page, api }) => {
  const cur = await api.settings();
  try {
    await openApp(page);
    await openSettings(page);
    const threshold = page.getByTestId('settings-threshold');
    const model = page.getByTestId('settings-model');
    const save = page.getByTestId('settings-save');
    const error = page.getByTestId('settings-error');
    await expect(model).toHaveValue(cur.model);

    for (const bad of ['2.5', '100000', '0']) {
      await threshold.fill(bad);
      await save.click();
      await expect(error).toHaveText('Commit reminder: enter a whole number between 1 and 1000.');
      await expect(page.getByTestId('settings-saved')).toBeHidden();
    }
    await threshold.fill(String(cur.commitReminderThreshold));

    await model.fill('nonexistent/model-xyz');
    await save.click();
    await expect(error).toContainText('nonexistent/model-xyz is not available');
    await expect(error).not.toContainText('Invalid input');
    expect((await api.settings()).model).toBe(cur.model);

    await model.fill(cur.model);
    await save.click();
    await expect(page.getByTestId('settings-saved')).toHaveText(/Saved$/);
    await expect(error).toBeHidden();
    await page.getByTestId('settings-dialog').screenshot({ path: 'tmp/fix2/16-settings.png' });
    expect((await api.settings()).model).toBe(cur.model);
    // Editing again clears the confirmation (not saved).
    await threshold.fill(String(cur.commitReminderThreshold + 1));
    await expect(page.getByTestId('settings-saved')).toBeHidden();
  } finally {
    // Never leave a broken server-wide model behind.
    await api.ctx.fetch('/api/settings', { method: 'PATCH', data: cur });
  }
});
