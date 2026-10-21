import { expect, openApp, test } from './helpers';

// #106: a tool chip too long for the column ends with an ellipsis (on its text), full path as tooltip.
// Real model turn (dev: OpenRouter) — the chip only exists once the model called a tool.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 20 * 60_000 });
const NAME = 'Wiki-synthesis-similaun-vs-cevedale-late-april-trip-comparison-of-equipment-and-routes.md';

test('@llm 106 a long tool chip is cut with an ellipsis and carries the path as tooltip', async ({ page, vault, api }) => {
  await api.write(vault.id, NAME, '# Trip\n');
  page.on('dialog', (d) => void d.accept());
  await openApp(page, vault.id);
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
  const chip = page.locator(`[data-testid="tool-chip"][data-path$="${NAME}"]`).first();
  const prompts = [
    `Call the read tool with filePath "${NAME}", then answer in one word.`,
    `Use the read tool now on "${NAME}".`,
    `Call the read tool with filePath "${NAME}".`,
  ];
  for (const prompt of prompts) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: TURN });
    if (await chip.count()) break;
  }
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', new RegExp(NAME));
  const text = chip.locator('.tc-t');
  const cut = await text.evaluate((el) => {
    const r = document.createRange(); r.selectNodeContents(el);
    return { clipped: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis', chipInside: el.getBoundingClientRect().right <= el.closest('.tc')!.getBoundingClientRect().right + 1 };
  });
  expect(cut).toEqual({ clipped: true, ellipsis: true, chipInside: true });
});
