import type { Browser, Page } from '@playwright/test';
import { Api, BASE_URL, expect, openApp, test, type TestVault } from './helpers';

// Real model turns (dev: local Ollama qwen2.5:3b on CPU) — slow. Few tests, long timeouts, and
// assertions on tool chips and the file system rather than on the answer text.
const TURN = 8 * 60_000;
// In order, one worker, one vault; a failing test doesn't skip the others.
test.describe.configure({ mode: 'default', timeout: 15 * 60_000 });
// `$=`: the model sometimes passes `./Home.md`, which the backend doesn't normalize (issue #12).

let api: Api;
let vault: TestVault;
test.beforeAll(async () => {
  api = await Api.create();
  vault = await api.createVault('chat');
});
test.afterAll(async () => {
  await api.removeVault(vault.id);
  await api.ctx.dispose();
});

async function newContextPage(browser: Browser, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true, baseURL: BASE_URL });
  const page = await ctx.newPage();
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  page.on('dialog', (d) => void d.accept());
  return { ctx, page };
}

async function send(page: Page, text: string) {
  await page.getByTestId('chat-composer').fill(text);
  await page.getByTestId('chat-send').click();
}

/** Waits until the turn is over: Send is back (Stop gone). */
async function waitIdle(page: Page) {
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: TURN });
}

// The small model sometimes writes stray files into the shared vault, which can push the
// changes count over the commit reminder threshold. The reminder isn't what these tests are
// about: dismiss it whenever it appears.
test.beforeEach(async ({ page }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
});

test('@llm chat on iPad: send, streaming answer, consulted-file chip; resume on iPhone; delete', async ({ browser }) => {
  const ipad = await newContextPage(browser, { width: 820, height: 1180 });
  const phone = await newContextPage(browser, { width: 390, height: 844 });
  try {
    const p = ipad.page;
    await openApp(p, vault.id);
    await p.getByTestId('chat-toggle').click();
    await p.getByTestId('new-chat').click();
    await expect(p.getByTestId('chat-messages')).toContainText('New chat');
    const prompt = 'Use the read tool to read the file Home.md, then answer in one short sentence: what does it say?';
    await send(p, prompt);
    await expect(p.getByTestId('chat-stop')).toBeVisible();
    await expect(p.locator('.turn-state')).toBeVisible({ timeout: TURN });

    const chip = p.locator('[data-testid="tool-chip"][data-path$="Home.md"]');
    await expect(chip.first()).toBeVisible({ timeout: TURN });
    await waitIdle(p);
    // The small model sometimes gets a call wrong first (e.g. `limit: null` → schema error) and
    // retries; what matters is a completed read of Home.md.
    await expect(p.locator('[data-testid="tool-chip"][data-path$="Home.md"][data-status="completed"]').first()).toBeVisible();
    await expect(p.getByTestId('assistant-message').first()).toBeVisible();
    // The small dev model sometimes ends the turn without any text; record it instead of failing.
    const answer = (await p.getByTestId('assistant-message').locator('.atext').allInnerTexts()).join(' ').trim();
    test.info().annotations.push({ type: 'answer', description: answer || '(no text answer)' });
    await p.screenshot({ path: test.info().outputPath('ipad-chat.png') });

    // Resume the same chat on the phone.
    const q = phone.page;
    await openApp(q, vault.id);
    await q.getByTestId('tab-chat').click();
    await expect(q.getByTestId('chat-item')).toHaveCount(1);
    await q.getByTestId('chat-item').click();
    await expect(q.locator('.msgs .u').first()).toHaveText(prompt);
    await expect(q.locator('[data-testid="tool-chip"][data-path$="Home.md"]').first()).toBeVisible();
    await q.screenshot({ path: test.info().outputPath('iphone-resumed-chat.png') });

    // Delete it.
    await q.getByTestId('chat-back').click();
    await q.getByTestId('chat-delete').click();
    await expect(q.getByTestId('chat-item')).toHaveCount(0);
  } finally {
    await ipad.ctx.close();
    await phone.ctx.close();
  }
});

test('@llm AI write → changed chip, "Open changed page", changes counter increments', async ({ page }) => {
  test.setTimeout(30 * 60_000); // up to three model turns
  // The model sometimes writes several extra files, which can cross the commit-reminder threshold
  await openApp(page, vault.id);
  const badge = page.getByTestId('changes-badge');
  const before = Number(await badge.getAttribute('data-count'));
  await expect(page.getByTestId('new-chat')).toBeVisible(); // chat pane open at 1280px
  await page.getByTestId('new-chat').click();
  const chip = page.locator('[data-testid="tool-chip"][data-writes="true"][data-status="completed"][data-path$="ai-note.md"]');
  // The 3B dev model sometimes invents a path (e.g. /path/to/ai-note.md → correctly denied); nudge it up to twice.
  const prompts = [
    'Use the write tool to create the file ai-note.md with exactly this content: "# AI note". Do nothing else.',
    'That did not work. Call the write tool with filePath set to exactly "ai-note.md" (relative, no folder) and content "# AI note".',
    'Call the write tool now: filePath "ai-note.md", content "# AI note".',
  ];
  for (const prompt of prompts) {
    await send(page, prompt);
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await waitIdle(page);
    if (await chip.count()) break;
  }
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/changed (\.\/)?ai-note\.md/);
  // The counter follows the event stream; the small model sometimes writes extra files, so
  // assert "went up and includes ai-note.md" rather than an exact count.
  await expect.poll(async () => Number(await badge.getAttribute('data-count'))).toBeGreaterThan(before);
  expect(await api.file(vault.id, 'ai-note.md')).not.toBeNull();

  await page.locator('[data-testid="open-changed"][data-path$="ai-note.md"]').click();
  await expect(page.locator('.note-title')).toHaveText('ai-note');
  await expect(page.locator('.cm-content')).toContainText('AI note');
});

test('@llm after two turns the chat gets a title from the title model (#148)', async ({ page }) => {
  await openApp(page, vault.id);
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  await send(page, 'hi');
  await expect(page.getByTestId('assistant-message')).toHaveCount(1, { timeout: TURN });
  await waitIdle(page);
  await send(page, 'Give me three tips for growing tomatoes on a balcony. Answer in two sentences, use no tools.');
  await expect(page.getByTestId('assistant-message')).toHaveCount(2, { timeout: TURN });
  await waitIdle(page);
  // The title job runs after the turn; the chat list learns the new title from the vault event.
  await page.getByTestId('chat-back').click();
  // The job's throwaway session never shows in the list: the chat is the only item all along.
  const items = page.getByTestId('chat-item');
  await expect(items).toHaveCount(1);
  const name = items.first().locator('.nm');
  await expect(name).toHaveText(/\S/);
  await expect(name).not.toHaveText(/^\s*hi\s*$/, { timeout: TURN });
  await expect(items).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('chat-title.png') });
  await page.getByTestId('chat-delete').first().click();
});

test('@llm Stop aborts a running turn', async ({ page }) => {
  await openApp(page, vault.id);
  await page.getByTestId('new-chat').click();
  await send(page, 'Write a very long, detailed essay (at least 2000 words) about the history of note-taking.');
  const stop = page.getByTestId('chat-stop');
  await expect(stop).toBeVisible();
  // Wait until the model is actually working, then stop.
  await expect(page.locator('.turn-state')).toContainText('Working', { timeout: TURN });
  await stop.click();
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 60_000 });
  // The session is usable again (the lock was released): the composer accepts a new prompt.
  await page.getByTestId('chat-composer').fill('hi');
  await expect(page.getByTestId('chat-send')).toBeEnabled();
});
