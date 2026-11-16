import type { Page } from '@playwright/test';
import { BASE_URL, expect, openApp, test } from './helpers';

// #175: a terminal panel on the server (the terminal service), started in the open vault, with Claude Code installed.
// Sessions live on the server until closed: a reload or a new browser reattaches and shows what ran before.
test.describe.configure({ mode: 'serial' });

/** The visible terminal text (xterm's DOM renderer). */
const screen = (page: Page) => page.getByTestId('terminal-xterm').locator('.xterm-rows');

type Ctx = { ctx: { get: (u: string) => Promise<{ json: () => Promise<unknown> }>; delete: (u: string) => Promise<unknown> } };
/** This vault's sessions (other tests run theirs in parallel: the terminal service is shared). */
async function sessions(api: Ctx, vault: string) {
  const { terminals } = (await (await api.ctx.get('/api/terminals')).json()) as { terminals: { id: string; cwd: string }[] };
  return terminals.filter((t) => t.cwd === vault || t.cwd.startsWith(`${vault}/`));
}
async function closeAll(api: Ctx, vault: string) {
  for (const t of await sessions(api, vault)) await api.ctx.delete(`/api/terminals/${t.id}`);
}

async function type(page: Page, text: string) {
  await page.getByTestId('terminal-xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('opens a shell in the vault, runs commands and Claude Code, survives a reload and a new browser', async ({ page, api, vault, browser }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByTestId('terminal-tab').filter({ hasText: vault.id })).toHaveCount(1);
  await type(page, 'pwd; echo "sum=$((40+2))"');
  await expect(screen(page)).toContainText(`/vaults/${vault.id}`);
  await expect(screen(page)).toContainText('sum=42');
  await type(page, 'ls; claude --version');
  await expect(screen(page)).toContainText('Home.md');
  await expect(screen(page)).toContainText('(Claude Code)', { timeout: 20_000 });
  await page.screenshot({ path: test.info().outputPath('175-terminal.png') });

  // Reload: the panel comes back by itself and reattaches to the same shell.
  await type(page, 'export MARK=kept-$((1+1))');
  await page.reload();
  await expect(page.getByTestId('terminal-panel')).toBeVisible({ timeout: 20_000 });
  await expect(screen(page)).toContainText('sum=42');
  await type(page, 'echo "$MARK"');
  await expect(screen(page)).toContainText('kept-2');

  // A new browser (fresh storage): the button reattaches to the running shell.
  const ctx = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  const other = await ctx.newPage();
  await openApp(other, vault.id);
  await other.getByTestId('open-terminal').click();
  await expect(screen(other)).toContainText('kept-2');
  await expect(other.getByTestId('terminal-tab').filter({ hasText: vault.id })).toHaveCount(1);
  await ctx.close();

  // ✕ ends the shell; the server forgets it.
  await page.getByTestId('terminal-tab').filter({ hasText: vault.id }).locator('..').getByTestId('terminal-close').click();
  await expect(page.getByTestId('terminal-tab').filter({ hasText: vault.id })).toHaveCount(0);
  expect(await sessions(api, vault.id)).toEqual([]);
  // Hidden: the panel goes, the toggle stays.
  await page.getByTestId('terminal-hide').click();
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
});

test('a file made in the terminal shows up in the app as a change', async ({ page, api, vault }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  await type(page, 'printf "# From the terminal\\n" > Terminal-note.md && echo "wr$((0))te"');
  await expect(screen(page)).toContainText('wr0te');
  await expect.poll(async () => (await api.changes(vault.id)).map((c) => c.path), { timeout: 15_000 }).toContain('Terminal-note.md');
  await closeAll(api, vault.id);
});

test('@iphone the terminal covers the screen and has a key bar for Esc, Tab and the arrows', async ({ page, api, vault }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByTestId('terminal-keys')).toBeVisible();
  await type(page, 'echo "p$((0))hone"');
  await expect(screen(page)).toContainText('p0hone');
  await page.screenshot({ path: test.info().outputPath('175-terminal-iphone.png') });
  // ^C from the key bar interrupts a running command.
  await type(page, 'sleep 30; echo "not$((0))cut"');
  await page.getByRole('button', { name: 'Control-C' }).click();
  await type(page, 'echo "after$((0))cut"');
  await expect(screen(page)).toContainText('after0cut');
  await expect(screen(page)).not.toContainText('not0cut');
  await page.getByTestId('terminal-hide').click();
  await closeAll(api, vault.id);
});

test('@ipad the terminal docks under the panes, with the key bar', async ({ page, api, vault }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  if ((await page.locator('#sidebar').getAttribute('inert')) !== null) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByTestId('terminal-keys')).toBeVisible();
  await type(page, 'echo "i$((0))pad"; hostname');
  await expect(screen(page)).toContainText('i0pad');
  await expect(screen(page)).toContainText('terminal');
  await page.screenshot({ path: test.info().outputPath('175-terminal-ipad.png') });
  await closeAll(api, vault.id);
});
