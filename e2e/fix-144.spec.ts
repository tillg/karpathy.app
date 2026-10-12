import { expect, openApp, openNote, test } from './helpers';

// #144: selecting text in the editor copies it (like a terminal) and a toast says so.
test('144 selecting text in the editor copies it and shows "Copied"', async ({ page, context, api, vault }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await api.write(vault.id, 'Copy144.md', '# Copy144\n\nbeta\n');
  await openApp(page, vault.id);
  await openNote(page, 'Copy144.md');

  await page.locator('.cm-line', { hasText: /^beta$/ }).dblclick();
  await expect(page.getByTestId('toast')).toHaveText('Copied');
  await expect(page.getByTestId('toast')).toHaveClass(/on/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('beta');

  // Keyboard selection (shift+arrows) copies too.
  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('x');

  // Select-all (Cmd/Ctrl+A) must not overwrite the clipboard: "copy elsewhere, select, paste to replace" keeps working.
  await page.evaluate(() => navigator.clipboard.writeText('keep-me'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('keep-me');
});
