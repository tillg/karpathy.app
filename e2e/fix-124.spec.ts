import type { Page } from '@playwright/test';
import { expect, openApp, openNote, test } from './helpers';

// #124: the AI saves a picture from a known URL into the vault (save_url) and the chat shows it as a changed
// file that opens in the media view. Real model turns (the dev model), so long timeouts and assertions on the
// chip and the file, never on answer text.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 20 * 60_000 });

const IMAGE = 'https://www.w3.org/Icons/w3c_home.png';
const PATH = 'notes/w3c.png';
// The model sometimes answers without calling the tool; nudge it once more.
const PROMPTS = [
  `Use the save_url tool to save ${IMAGE} into the vault as ${PATH}. Do nothing else.`,
  `Call the save_url tool now with url "${IMAGE}" and filePath "${PATH}".`,
];

const savedChip = (page: Page) => page.locator(`[data-testid="tool-chip"][data-writes="true"][data-path="${PATH}"]`);

test('@llm the AI saves a picture from the web into the vault', async ({ page, api, vault }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  for (const prompt of PROMPTS) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });
    if (await savedChip(page).count()) break;
  }
  const chip = savedChip(page).first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(`changed ${PATH}`);
  await chip.screenshot({ path: test.info().outputPath('saved-chip.png'), scale: 'css' });
  // The bytes are a PNG, served from the vault, and it is an uncommitted change.
  const raw = await api.ctx.get(`/api/vaults/${vault.id}/raw?path=${encodeURIComponent(PATH)}`);
  expect(raw.status()).toBe(200);
  expect((await raw.body()).subarray(1, 4).toString()).toBe('PNG');
  expect((await api.changes(vault.id)).map((c) => c.path)).toContain(PATH);
  // A tap on the chip shows it in the media view.
  await chip.click();
  await expect(page.locator('.media-view img')).toBeVisible();
  await expect(page.locator('.media-view .note-title')).toHaveText('w3c.png');
  await page.screenshot({ path: test.info().outputPath('media-view.png'), scale: 'css' });
});

test('@llm asked to add a picture to a note, the AI saves it and embeds it', async ({ page, api, vault }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  await page.getByTestId('chat-composer').fill(`Add this picture to the note Ideas.md: ${IMAGE}`);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-stop')).toBeAttached();
  await expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });
  const saved = (await api.changes(vault.id)).map((c) => c.path).filter((p) => p.endsWith('.png'));
  expect(saved).toHaveLength(1);
  const name = saved[0]!.split('/').pop()!;
  // Either embed form, by path or by name.
  expect((await api.file(vault.id, 'Ideas.md'))!.content).toMatch(new RegExp(`!\\[[^\\]]*\\]?\\]?\\(?[^)\\]]*${name.replace('.', '\\.')}`));
  // The note shows the picture (Write mode's live preview).
  await openNote(page, 'Ideas.md');
  await expect.poll(() => page.locator('.cm-content .embed img').first().evaluate((e: HTMLImageElement) => e.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('note-with-picture.png'), scale: 'css' });
});
