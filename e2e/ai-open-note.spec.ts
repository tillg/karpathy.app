import type { Page } from '@playwright/test';
import { BASE_URL, expect, openApp, openNote, test, typeAtEnd } from './helpers';

// The AI's open_note tool opens a note in the UI (spec change ai-open-page). Real model turns
// (dev: OpenRouter), so long timeouts and assertions on chips and the route, never answer text.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 25 * 60_000 });

const TODO = 'notes/Todo.md';
const OTHER = 'notes/Other.md';
// The small dev model sometimes answers without calling the tool; nudge it once more.
const PROMPTS = [
  `Use the open_note tool to open the note ${TODO} for me. Do nothing else.`,
  `Call the open_note tool now with path "${TODO}".`,
];
type Device = 'desktop' | 'ipad' | 'iphone';
const VIEWPORT = { desktop: { width: 1280, height: 800 }, ipad: { width: 820, height: 1180 }, iphone: { width: 390, height: 844 } };

const openedChip = (page: Page) => page.locator(`[data-testid="tool-chip"][data-opens="true"][data-path="${TODO}"]`);
const turnOver = (page: Page) => expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });

async function showChat(page: Page, device: Device) {
  if (device === 'iphone') await page.getByTestId('tab-chat').click();
  // A closed chat pane is slid off-screen and inert (still "visible" to Playwright).
  else if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
}

/** Sends the open prompt (retrying once if the model made no open call); `during` runs right after each send. */
async function promptOpen(page: Page, device: Device, during?: () => Promise<void>) {
  for (const prompt of PROMPTS) {
    await showChat(page, device);
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeAttached();
    await during?.();
    await turnOver(page);
    if (await openedChip(page).count()) return;
  }
  await page.screenshot({ path: `tmp/ai-open-page/${device}-no-open.png` });
  throw new Error('no opened chip: the model never called open_note, or the UI shows no such chip');
}

async function expectNote(page: Page, path: string) {
  await expect(page.locator('.note-title')).toHaveText(path.split('/').pop()!.replace(/\.md$/, ''));
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toMatch(new RegExp(`/${path}$`));
}

for (const device of ['desktop', 'ipad', 'iphone'] as const) {
  test(`@llm AI opens a note (${device})`, async ({ browser, api, vault }) => {
    await api.write(vault.id, TODO, '# Todo\n\nBuy milk\n');
    await api.write(vault.id, OTHER, '# Other\n\nSomething else\n');
    const ctx = await browser.newContext({ viewport: VIEWPORT[device], hasTouch: device !== 'desktop', isMobile: device !== 'desktop', ignoreHTTPSErrors: true, baseURL: BASE_URL });
    const page = await ctx.newPage();
    const reminder = page.getByTestId('reminder-dialog');
    await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
    try {
      await openApp(page, vault.id);
      await showChat(page, device);
      await page.getByTestId('new-chat').click();
      await promptOpen(page, device);
      // 1. The AI's open request shows the note.
      await expectNote(page, TODO);
      await page.screenshot({ path: `tmp/ai-open-page/${device}-opened.png` });

      // 2. The user moves on; a reload doesn't reopen Todo from the chat history.
      if (device === 'iphone') await page.getByTestId('back').click();
      if (device === 'ipad') await page.getByTestId('sidebar-toggle').click();
      await openNote(page, OTHER);
      await page.reload();
      await expectNote(page, OTHER);

      // 3. The chip in the chat leads back.
      await showChat(page, device);
      await page.getByTestId('chat-item').click();
      await expect(openedChip(page)).toContainText(`opened ${TODO}`);
      if (device === 'desktop') await expectNote(page, OTHER); // loading the history opened nothing
      await page.screenshot({ path: `tmp/ai-open-page/${device}-chip.png` });
      await openedChip(page).click();
      await expectNote(page, TODO);
    } finally {
      await ctx.close();
    }
  });
}

test("@llm AI opens a note: doesn't switch while the user edits", async ({ page, api, vault }) => {
  await api.write(vault.id, TODO, '# Todo\n\nBuy milk\n');
  await api.write(vault.id, OTHER, '# Other\n\nSomething else\n');
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  await openNote(page, OTHER);
  await page.getByTestId('new-chat').click();
  // Sending moves focus to the chat; the user goes straight back to typing in the note.
  let n = 0;
  await promptOpen(page, 'desktop', () => typeAtEnd(page, ` typed${++n}`));
  await expectNote(page, OTHER);
  await expect(page.locator('.cm-content')).toContainText(` typed${n}`);
  await expect(page.getByTestId('toast')).toHaveText(`AI opened ${TODO}`);
  await expect(openedChip(page)).toBeVisible();
  await page.screenshot({ path: 'tmp/ai-open-page/desktop-editing.png' });
});
