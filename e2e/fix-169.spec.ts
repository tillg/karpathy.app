import { expect, openApp, test } from './helpers';

// #169: a failed reply's error pill says which tool was running when it failed, or that it was the model.
// The failure can't be provoked on a dev stack (no hook makes opencode or the provider fail), so the chat's
// stored messages come back from the backend as a failed turn would leave them (shape: harness-map tests).
test.use({ serviceWorkers: 'block' }); // page.route must see the fetch (see fix-14)
test('@iphone the error pill names the failing tool, or the model', async ({ page, api, vault }) => {
  const { chatId } = (await (await api.ctx.post(`/api/vaults/${vault.id}/chats`, { data: {} })).json()) as { chatId: string };
  const user = (id: string, text: string) => ({ id, role: 'user', createdAt: 1, parts: [{ type: 'text', id: `${id}p`, text }] });
  const failed = (id: string, errorOrigin: object) => ({ id, role: 'assistant', createdAt: 2, model: 'openrouter/qwen/qwen3-8b', parts: [], error: 'Insufficient credits', errorOrigin });
  await page.route((u) => u.pathname === `/api/vaults/${vault.id}/chats/${chatId}`, async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, turn: 'idle', messages: [
      user('u1', 'Search the web for llama prices.'),
      failed('a1', { kind: 'tool', tool: 'websearch' }),
      user('u2', 'Try again.'),
      failed('a2', { kind: 'model' }),
    ] } });
  });
  await openApp(page, vault.id);
  if (await page.getByTestId('tab-chat').isVisible()) await page.getByTestId('tab-chat').click();
  await page.getByTestId('chat-item').first().click();
  const pills = page.getByTestId('chat-error');
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(0)).toHaveText('During tool websearch: Insufficient credits');
  await expect(pills.nth(0)).toHaveAttribute('data-tool', 'websearch');
  await expect(pills.nth(1)).toHaveText('From the model qwen3-8b: Insufficient credits');
  await page.screenshot({ path: test.info().outputPath('169-error-pills.png') });
  await page.unrouteAll();
  await api.ctx.delete(`/api/vaults/${vault.id}/chats/${chatId}`);
});
