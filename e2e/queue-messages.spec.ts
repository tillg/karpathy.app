import { expect, openApp, test } from './helpers';

// #155: while the AI works, the composer stays usable. A message sent meanwhile waits as a queued bubble (Edit, ✕),
// survives a reload, comes back into the composer on Stop, and goes out by itself once the turn ends.

test('@llm queue while the AI works: bubbles with Edit and remove, kept over a reload, Stop puts them back', async ({ page, vault }) => {
  test.setTimeout(10 * 60_000);
  page.on('dialog', (d) => void d.accept());
  await openApp(page, vault.id);

  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
  const box = page.getByTestId('chat-composer');
  await box.fill('Write a very long, detailed essay (at least 2000 words) about the history of note-taking.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-stop')).toBeVisible();

  // The composer is still usable; with something typed, Send shows next to Stop.
  await expect(box).toBeEnabled();
  await box.fill('QUEUED ONE: then say hi.');
  await expect(page.getByTestId('chat-stop')).toBeVisible();
  await page.getByTestId('chat-send').click();
  await expect(box).toHaveValue('');
  await box.fill('QUEUED TWO: to be edited.');
  await box.press('Enter');
  const queued = page.getByTestId('queued-prompt');
  await expect(queued).toHaveCount(2);
  await expect(queued.nth(0)).toContainText('QUEUED ONE');
  await expect(queued.nth(0)).toContainText('Queued');
  await page.screenshot({ path: test.info().outputPath('155-queued.png') });

  // Edit: the second one goes back into the composer.
  await queued.nth(1).getByTestId('queued-edit').click();
  await expect(box).toHaveValue('QUEUED TWO: to be edited.');
  await expect(queued).toHaveCount(1);
  await box.fill('');

  // A reload keeps the queued message (it lives on the server).
  await page.reload();
  await page.getByTestId('chat-item').first().click();
  await expect(page.getByTestId('queued-prompt')).toHaveCount(1);
  await expect(page.getByTestId('queued-prompt')).toContainText('QUEUED ONE');

  // Stop ends the turn and puts the queued message back into the composer: nothing starts after a Stop.
  await page.getByTestId('chat-stop').click();
  await expect(page.getByTestId('chat-composer')).toHaveValue('QUEUED ONE: then say hi.');
  await expect(page.getByTestId('queued-prompt')).toHaveCount(0);
  await expect(page.getByTestId('chat-stop')).toBeHidden({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('chat-messages').locator('.u')).toHaveCount(1);
});

test('@llm a queued message goes out by itself when the turn ends', async ({ page, vault }) => {
  test.setTimeout(10 * 60_000);
  await openApp(page, vault.id);
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
  const box = page.getByTestId('chat-composer');
  await box.fill('Reply with the single word ALPHA and nothing else.');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-stop')).toBeVisible();
  await box.fill('Reply with the single word BETA and nothing else.');
  await page.getByTestId('chat-send').click();

  // Both prompts end up in the chat as user messages, in order, and the chat goes idle.
  const users = page.getByTestId('chat-messages').locator('.u:not(.pending)');
  await expect(users).toHaveCount(2, { timeout: 5 * 60_000 });
  await expect(users.nth(0)).toContainText('ALPHA');
  await expect(users.nth(1)).toContainText('BETA');
  await expect(page.getByTestId('chat-stop')).toBeHidden({ timeout: 5 * 60_000 });
  await expect(page.getByTestId('queued-prompt')).toHaveCount(0);
  // The second prompt was answered (the small dev model may leave the first one without a reply of its own).
  await expect(page.getByTestId('assistant-message').last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('155-sent.png') });
});
