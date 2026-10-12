import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openApp, test } from './helpers';

// An attached image and a text-only chat model: the AI calls look_at_image and answers from the vision model's
// description (spec change 146-image-model). Real model turns (dev: local Ollama), so long timeouts and
// assertions on chips, never on answer text.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 25 * 60_000 });

const ROOT = join(import.meta.dirname, '..');
// The small dev model sometimes answers without calling the tool; nudge it again.
const PROMPTS = [
  'What colour is the attached image? Use the look_at_image tool on the attached file. Do nothing else.',
  'Call the look_at_image tool now with the path of the attached red.png.',
];

const lookChip = (page: Page) => page.locator('[data-testid="tool-chip"][data-path$="red.png"]').filter({ hasText: 'look_at_image' });

test('@llm AI answers about an attached image through look_at_image', async ({ page, vault }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeEnabled();
  await page.getByTestId('chat-attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/red.png'));
  const chip = page.getByTestId('attach-chip');
  await expect(chip).toHaveCount(1);
  // A text-only model gets the image described by the tool: no warning.
  await expect(chip.locator('.achip-warn')).toHaveCount(0);

  for (const [i, prompt] of PROMPTS.entries()) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });
    if (await lookChip(page).count()) break;
    if (i === PROMPTS.length - 1) {
      await page.screenshot({ path: 'tmp/ai-image/no-chip.png' });
      throw new Error('no look_at_image chip: the model never called the tool, or the UI shows no such chip');
    }
  }
  await expect(lookChip(page).first()).toHaveAttribute('data-status', 'completed');
  await page.screenshot({ path: 'tmp/ai-image/chip.png' });
});
