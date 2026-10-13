import { expect, openApp, test } from './helpers';

// Chat list last entry + context bar, composer context meter (#140). One real model turn (dev: local
// Ollama qwen2.5:3b, context window 16,384 from deploy/settings/) — slow, so one test does it all.
const TURN = 8 * 60_000;

test('@llm a turn fills the context meter; the chat list shows the time, a bar and the newest chat first', async ({ page, vault }) => {
  test.setTimeout(15 * 60_000);
  await openApp(page, vault.id);
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());

  // A new chat has no meter yet.
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('context-meter')).toHaveCount(0);

  await page.getByTestId('chat-composer').fill('Say hello in one word.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: TURN });

  // The composer: used / the dev model's window, from the provider config.
  const meter = page.getByTestId('context-meter');
  // Short numbers: e.g. 4K / 16K.
  await expect(meter).toHaveText(/^\d+K? \/ 16K$/, { timeout: 30_000 });
  const used = Number(await meter.getByRole('meter').getAttribute('aria-valuenow'));
  expect(used).toBeGreaterThan(0);
  await expect(meter.getByRole('meter')).toHaveAttribute('aria-valuemax', '16384');

  // The chat list: this chat first, with a time and a bar.
  await page.getByTestId('chat-back').click();
  const first = page.getByTestId('chat-item').first();
  await expect(first).toContainText('hello', { ignoreCase: true });
  await expect(first.locator('.cnt')).toHaveText(/\d{1,2}:\d{2}/);
  await expect(first.getByRole('meter')).toHaveAttribute('aria-valuenow', String(used));
});
