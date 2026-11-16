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
  // The shell echoed the line: it ran (a page can't send keys it hasn't been given yet).
  await expect(screen(page)).toContainText('export MARK=kept-$((1+1))');
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

test('two browsers on one session (Mac and phone): both see everything, both type; the shell takes the size of the one in use', async ({ page, api, vault, browser }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  await expect(page.getByTestId('terminal-tab').filter({ hasText: vault.id })).toHaveCount(1);
  await type(page, 'echo "fr$((0))m-mac"');
  await expect(screen(page)).toContainText('fr0m-mac');

  const ctx = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true, viewport: { width: 1000, height: 800 } });
  const other = await ctx.newPage();
  await openApp(other, vault.id);
  // Not wide: the sidebar with the button opens on demand.
  await other.getByTestId('sidebar-toggle').click();
  await other.getByTestId('open-terminal').click();
  await expect(screen(other)).toContainText('fr0m-mac');
  await type(other, 'echo "fr$((0))m-phone"; stty size');
  // The first page keeps streaming: it sees what the other one typed and ran.
  for (const p of [page, other]) await expect(screen(p)).toContainText('fr0m-phone');
  await page.waitForTimeout(3000);
  await type(page, 'echo "ag$((0))ain"; stty size');
  for (const p of [page, other]) await expect(screen(p)).toContainText('ag0ain');

  // stty prints "rows cols": the narrow page's width while it typed, the wide one's after.
  const sizes = (await screen(page).innerText()).match(/^\d+ \d+$/gm)!.map((l) => Number(l.split(' ')[1]));
  expect(sizes).toHaveLength(2);
  expect(sizes[1]!).toBeGreaterThan(sizes[0]!);
  await ctx.close();
});

test('zsh like on the Mac: ↑ goes through the history, filtered by what is typed; a powerline prompt in colour', async ({ page, api, vault }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  for (const w of ['alpha-1', 'beta-2', 'alpha-3']) {
    await type(page, `echo ${w}`);
    await expect(screen(page)).toContainText(`${w}\n`.trim());
  }
  // "echo a" then ↑: only the lines that start with it, newest first.
  await page.keyboard.type('echo a');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await screen(page).innerText()).match(/^alpha-1$/gm) ?? []).length).toBe(2);
  // Plain ↑ is the last command again.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await screen(page).innerText()).match(/^alpha-1$/gm) ?? []).length).toBe(3);

  // The prompt font (Nerd Font icons) has loaded, and the prompt has colour.
  await expect.poll(() => page.evaluate(() => document.fonts.check('13px "MesloLGS NF"'))).toBe(true);
  expect(await screen(page).locator('[class*="xterm-bg-"], [style*="background-color"]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('175-zsh.png') });
  await closeAll(api, vault.id);
});

test('vault commit: commit and push from the terminal through the app; git commit points to it', async ({ page, api, vault }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  await type(page, 'echo "# From vault" > From-vault.md && git add From-vault.md; echo "rc$((1+1))=$?"');
  await expect(screen(page)).toContainText('git is read-only in this terminal');
  await type(page, 'vault status');
  await expect(screen(page)).toContainText('From-vault.md');
  await type(page, 'vault commit -m "From the terminal"');
  await expect(screen(page)).toContainText('and pushed', { timeout: 30_000 });
  await expect.poll(async () => (await api.status(vault.id)).changedCount).toBe(0);
  expect((await api.status(vault.id)).unpushedCount).toBe(0);
  await closeAll(api, vault.id);
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

test('a URL a program broke over several rows opens whole; selecting text copies it', async ({ page, api, vault, context, browserName }) => {
  await closeAll(api, vault.id);
  await openApp(page, vault.id);
  await page.getByTestId('open-terminal').click();
  // fold: hard line breaks at the terminal's width, as Claude Code prints its login URL.
  const url = `${BASE_URL}/#long-${'x'.repeat(260)}-end`;
  await type(page, `clear; printf '%s\\n' '${url}' | fold -w $(tput cols); echo "d$((0))ne"`);
  await expect(screen(page)).toContainText('d0ne');
  // xterm's layers sit above the row elements: aim the mouse at the row's position instead of the element.
  const second = (await screen(page).locator(':scope > div').filter({ hasText: /^x+/ }).first().boundingBox())!;
  await page.mouse.move(second.x + 30, second.y + second.height / 2);
  await page.mouse.move(second.x + 40, second.y + second.height / 2);
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.mouse.click(second.x + 40, second.y + second.height / 2)]);
  await expect.poll(() => popup.url()).toBe(url);
  await popup.close();

  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await type(page, 'echo "se$((1))ect me"');
    const row = screen(page).locator(':scope > div').filter({ hasText: /^se1ect me/ }).first();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^se1ec/);
    // The broken URL, selected over its rows, copies as one line.
    const first = (await screen(page).locator(':scope > div').filter({ hasText: /^https:/ }).first().boundingBox())!;
    const last = (await screen(page).locator(':scope > div').filter({ hasText: /-end/ }).first().boundingBox())!;
    await page.mouse.move(first.x + 1, first.y + first.height / 2);
    await page.mouse.down();
    // Past the text's end: xterm drops the row's trailing blanks.
    await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  }
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
