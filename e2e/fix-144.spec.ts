import { expect, openApp, openNote, test } from './helpers';

// #144: selecting text in the editor copies it (like a terminal) and a toast says so.
test('144 selecting text in the editor copies it and shows "Copied"', async ({ page, context, api, vault, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only: WebKit refuses clipboard-read/clipboard-write permissions');
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

test('144 selecting text in Read mode copies it too', async ({ page, context, api, vault, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only: WebKit refuses clipboard-read/clipboard-write permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await api.write(vault.id, 'CopyRead144.md', '# CopyRead144\n\ngamma delta\n');
  await openApp(page, vault.id);
  await openNote(page, 'CopyRead144.md');
  await page.getByTestId('mode-read').click();

  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await page.getByTestId('read-view').getByText('gamma delta').dblclick({ position: { x: 8, y: 8 } }); // on "gamma", not the paragraph's empty middle
  await expect(page.getByTestId('toast')).toHaveText('Copied');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('x');
  expect(['gamma', 'delta']).toContain((await page.evaluate(() => navigator.clipboard.readText())).trim());
});

test('144 selecting text in the chat copies it too', async ({ page, context, vault, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only: WebKit refuses clipboard-read/clipboard-write permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page, vault.id);
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  const messages = page.getByTestId('chat-messages');
  await expect(messages).toContainText('New chat');

  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await messages.getByText(/New chat/).dblclick({ position: { x: 8, y: 8 } }); // on "New"
  await expect(page.getByTestId('toast')).toHaveText('Copied');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('x');

  // Keyboard selection (shift+arrows) copies too.
  await page.evaluate(() => navigator.clipboard.writeText('x'));
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('x');

  // Text in the composer isn't copied on select: selecting to replace it must keep the clipboard.
  await page.evaluate(() => navigator.clipboard.writeText('keep-me'));
  await page.getByTestId('chat-composer').fill('hello world');
  await page.getByTestId('chat-composer').dblclick();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('keep-me');
});
