import type { Page } from '@playwright/test';
import { BASE_URL, expect, openApp, test } from './helpers';

// The AI's suggest_next tool puts a next prompt into the composer as ghost text (spec change
// 145-next-prompt-suggestion). Real model turns (dev: local Ollama), so long timeouts and assertions on the UI,
// never on answer text; the exact suggestion is whatever the model sent.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 25 * 60_000 });

// The small dev model sometimes answers without calling the tool; nudge it again.
const PROMPTS = [
  'Say "ok". After that, as your very last action, call the suggest_next tool with the prompt "Summarize the open points". Do nothing else.',
  'Call the suggest_next tool now with the prompt "Summarize the open points".',
  'Use suggest_next with prompt "Summarize the open points".',
];
type Device = 'desktop' | 'iphone';
const VIEWPORT = { desktop: { width: 1280, height: 800 }, iphone: { width: 390, height: 844 } };

const ghost = (page: Page) => page.getByTestId('chat-ghost');
const turnOver = (page: Page) => expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });

async function showChat(page: Page, device: Device) {
  if (device === 'iphone') await page.getByTestId('tab-chat').click();
  else if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
}

/** Sends prompts until a turn ends with ghost text (the model must have called the tool). */
async function promptForSuggestion(page: Page, device: Device) {
  for (const prompt of PROMPTS) {
    await showChat(page, device);
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await turnOver(page);
    if (await ghost(page).count()) return;
  }
  await page.screenshot({ path: `tmp/ai-suggest-next/${device}-no-ghost.png` });
  throw new Error('no ghost text: the model never called suggest_next, or the UI shows none');
}

for (const device of ['desktop', 'iphone'] as const) {
  test(`@llm the AI's suggestion shows as ghost text and is accepted (${device})`, async ({ browser, vault }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT[device], hasTouch: device === 'iphone', isMobile: device === 'iphone', ignoreHTTPSErrors: true, baseURL: BASE_URL });
    const page = await ctx.newPage();
    const reminder = page.getByTestId('reminder-dialog');
    await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
    try {
      await openApp(page, vault.id);
      await showChat(page, device);
      await page.getByTestId('new-chat').click();
      // A fresh chat has no suggestion.
      await expect(page.getByTestId('chat-composer')).toBeVisible();
      await expect(ghost(page)).toHaveCount(0);

      await promptForSuggestion(page, device);
      const composer = page.getByTestId('chat-composer');
      const suggestion = (await page.getByTestId('chat-ghost').locator('.ghost-t').textContent())!;
      expect(suggestion.length).toBeGreaterThan(0);
      await expect(composer).toHaveValue('');
      // The call has no chip of its own.
      await expect(page.getByTestId('tool-chip')).toHaveCount(0);
      await page.screenshot({ path: `tmp/ai-suggest-next/${device}-ghost.png` });

      // It stays after a reload (derived from the chat history).
      await page.reload();
      await showChat(page, device);
      await page.getByTestId('chat-item').click();
      await expect(ghost(page)).toBeVisible();

      const users = () => page.locator('.u').count();
      const before = await users();
      if (device === 'desktop') await composer.press('Tab');
      else await page.getByTestId('chat-suggestion').tap();
      // Accepting fills the composer, sends nothing, and the ghost is gone.
      await expect(composer).toHaveValue(suggestion);
      await expect(ghost(page)).toHaveCount(0);
      expect(await users()).toBe(before);
      await page.screenshot({ path: `tmp/ai-suggest-next/${device}-accepted.png` });

      // Clearing the composer brings it back; typing removes it again.
      await composer.fill('');
      await expect(ghost(page)).toBeVisible();
      await composer.pressSequentially('x');
      await expect(ghost(page)).toHaveCount(0);

      // Enter sends the accepted text as the next prompt.
      await composer.fill('');
      if (device === 'desktop') await composer.press('Tab');
      else await page.getByTestId('chat-suggestion').tap();
      await expect(composer).toHaveValue(suggestion);
      await page.getByTestId('chat-send').click();
      await expect(page.locator('.u')).toHaveCount(before + 1);
      await expect(page.locator('.u').last()).toHaveText(suggestion);
      // While the new turn runs there is no ghost text.
      await expect(ghost(page)).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
}
