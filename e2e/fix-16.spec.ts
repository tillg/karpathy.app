import { expect, openApp, openSettings, test } from './helpers';

// #16: settings show "Saved", reject bad input with human-readable messages and unknown models.
// Settings are server-wide: the test only saves the current values, and restores them regardless.
// In admin mode the commit reminder is in General and the model in AI, each with its own Save.
test('settings: saved feedback, readable validation errors, unknown model refused', async ({ page, api }) => {
  const cur = await api.settings();
  try {
    await openApp(page);
    const threshold = page.getByTestId('settings-threshold');
    const model = page.getByTestId('settings-model');
    const save = page.getByTestId('settings-save');
    const error = page.getByTestId('settings-error');
    const ai = await openSettings(page, 'ai');
    await expect(model).toHaveValue(cur.model);
    await openSettings(page, 'general');

    for (const bad of ['2.5', '100000', '0']) {
      await threshold.fill(bad);
      await save.click();
      await expect(error).toHaveText('Commit reminder: enter a whole number between 1 and 1000.');
      await expect(page.getByTestId('settings-saved')).toBeHidden();
    }
    await threshold.fill(String(cur.commitReminderThreshold));

    await openSettings(page, 'ai');
    await model.fill('nonexistent/model-xyz');
    await save.click();
    await expect(error).toContainText('nonexistent/model-xyz is not available');
    await expect(error).not.toContainText('Invalid input');
    expect((await api.settings()).model).toBe(cur.model);

    await model.fill(cur.model);
    await save.click();
    await expect(page.getByTestId('settings-saved')).toHaveText(/Saved$/);
    await expect(error).toBeHidden();
    await ai.screenshot({ path: 'tmp/fix2/16-settings.png' });
    expect((await api.settings()).model).toBe(cur.model);
    // Editing again clears the confirmation (not saved).
    await model.fill(`${cur.model}x`);
    await expect(page.getByTestId('settings-saved')).toBeHidden();
  } finally {
    // Never leave a broken server-wide model behind.
    await api.ctx.fetch('/api/settings', { method: 'PATCH', data: cur });
  }
});
