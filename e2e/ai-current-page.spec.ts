import type { Page } from '@playwright/test';
import { backendExec, expect, openApp, openNote, test, uid } from './helpers';

// The AI's current_page tool tells which file the user has open (spec change 143-open-page-tool). The first test is
// deterministic: the web app sends the open page with each message and the backend stores it for the tool, outside
// the vault. The second uses the real model (dev: local Ollama), so long timeouts and assertions on the chip only.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 25 * 60_000 });

/** What the backend has stored for the tool: every chat's open page (the unique note path picks ours). */
const stored = () => backendExec('sh', '-c', 'cat /vaults/.open-page/*.json 2>/dev/null; true');
const turnOver = (page: Page) => expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });

async function showChat(page: Page) {
  if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
}

async function send(page: Page, text: string) {
  await showChat(page);
  await page.getByTestId('chat-composer').fill(text);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-stop')).toBeAttached();
}

test('each message carries the open file to the backend', async ({ page, api, vault }) => {
  const a = `notes/Open-${uid()}.md`;
  const b = `notes/Next-${uid()}.md`;
  await api.write(vault.id, a, '# A\n\nBuy milk\n');
  await api.write(vault.id, b, '# B\n\nSomething else\n');
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  await openNote(page, a);
  await showChat(page);
  await page.getByTestId('new-chat').click();
  await send(page, 'what is in this note?');
  await expect.poll(stored).toContain(`"path":"${a}","mode":"write","unsaved":false`);
  await turnOver(page);
  // The user moves on: the next message carries the new file.
  await openNote(page, b);
  await send(page, 'and in this one?');
  await expect.poll(stored).toContain(`"path":"${b}"`);
  await turnOver(page);
  // Never a file in the vault's clone.
  expect(backendExec('ls', '-a', `/vaults/${vault.id}`)).not.toContain('.open-page');
  await page.screenshot({ path: 'tmp/ai-current-page/sent.png' });
});

test('@llm the AI asks for the open page', async ({ page, api, vault }) => {
  const note = `notes/Todo-${uid()}.md`;
  await api.write(vault.id, note, '# Todo\n\nBuy milk\n');
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  await openNote(page, note);
  await showChat(page);
  await page.getByTestId('new-chat').click();
  const chip = page.locator('[data-testid="tool-chip"]', { hasText: 'current_page' });
  // The small dev model sometimes answers without calling the tool; nudge it once more.
  for (const prompt of ['Use the current_page tool to find out which page I have open. Do nothing else.', 'Call the current_page tool now.']) {
    await send(page, prompt);
    await turnOver(page);
    if (await chip.count()) break;
  }
  await page.screenshot({ path: 'tmp/ai-current-page/chip.png' });
  await expect(chip.first()).toHaveAttribute('data-status', 'completed');
});
