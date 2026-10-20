import { expect, openApp, test } from './helpers';

// #63: one assistant block per turn (tool steps grouped under one header); a failed chip shows its
// error on tap. Real model turns (dev: OpenRouter) — slow, assertions on structure, not text.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 20 * 60_000 });

test('@iphone @llm a multi-step turn has one header; a failed step\'s error opens on tap', async ({ page, vault }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  page.on('dialog', (d) => void d.accept());
  await openApp(page, vault.id);
  await page.getByTestId('tab-chat').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
  // The 3B dev model sometimes answers without calling a tool; nudge it up to twice.
  const prompts = [
    'Use the read tool to read Home.md, then use the read tool to read does-not-exist.md, then answer in one short sentence.',
    'Call the read tool now with filePath "Home.md", then call it with filePath "does-not-exist.md".',
    'Call the read tool with filePath "Ideas.md".',
  ];
  const chips = page.locator('[data-testid="tool-chip"]');
  for (const prompt of prompts) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: TURN });
    if (await chips.count()) break;
  }
  await expect(chips.first()).toBeVisible();
  // One header per prompt, however many steps (assistant messages) each turn took.
  const prompted = await page.locator('.msgs .u').count();
  await expect(page.getByTestId('assistant-message')).toHaveCount(prompted);
  await expect(page.locator('.a .who')).toHaveCount(prompted);
  const failed = page.locator('[data-testid="tool-chip"][data-status="error"], [data-testid="tool-chip"][data-status="denied"]');
  if (await failed.count()) {
    await failed.first().click();
    await expect(page.getByTestId('tool-error').first()).toBeVisible();
  } else test.info().annotations.push({ type: 'note', description: 'model made no failing call' });
    await page.screenshot({ path: 'tmp/fix6/63-iphone.png', fullPage: true });
});
