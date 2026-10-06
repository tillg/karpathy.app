import type { Page } from '@playwright/test';
import { expect, openApp, test } from './helpers';

// The AI's open_url tool offers a web page; the Open chip opens it in a new tab on the user's tap only
// (spec change chat-commands-research). Real model turns (the dev model), so long timeouts and assertions
// on the chip and the popup, never on answer text.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 20 * 60_000 });

const URL_ = 'https://example.com/';
// The model sometimes answers without calling the tool; nudge it once more.
const PROMPTS = [
  `Use the open_url tool to open ${URL_} for me in my browser. Do nothing else.`,
  `Call the open_url tool now with url "${URL_}".`,
];

const openChip = (page: Page) => page.locator('[data-testid="tool-chip"][data-opens-url="true"]');

test('@llm the Open chip opens a new tab on tap', async ({ page, context, vault }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  const popups: Page[] = [];
  context.on('page', (p) => popups.push(p));
  for (const prompt of PROMPTS) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });
    if (await openChip(page).count()) break;
  }
  const chip = openChip(page).first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('open example.com/');
  await expect(chip).toHaveAttribute('target', '_blank');
  await expect(chip).toHaveAttribute('rel', 'noopener noreferrer');
  // Nothing opened by itself.
  expect(popups).toEqual([]);
  await chip.screenshot({ path: test.info().outputPath('open-chip.png'), scale: 'css' });
  const [popup] = await Promise.all([context.waitForEvent('page'), chip.click()]);
  await expect.poll(() => popup.url()).toBe(URL_);
});
