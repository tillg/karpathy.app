import type { Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, git, openApp, pushFromObsidian, test } from './helpers';

// Command palette, command chips and the agents-move notice. No model turn is needed: a sent prompt is
// stopped at once (the dev stack runs a real model).

// The move adds uncommitted changes, which can bring up the commit reminder: not what these tests are about.
test.beforeEach(async ({ page }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
});

/** Opens a new chat in whatever layout the project uses (desktop/iPad toggle, iPhone tab). */
async function newChat(page: Page) {
  if (await page.getByTestId('tab-chat').isVisible()) await page.getByTestId('tab-chat').click();
  // A closed chat pane is slid off-screen and inert (still "visible" to Playwright).
  else if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
}

/** Sends the composer's text and stops the turn right away. */
async function sendAndStop(page: Page) {
  await page.getByTestId('chat-send').click();
  await expect(page.locator('.msgs .u').first()).toBeVisible();
  // The turn may be over before Stop shows (the dev model errors fast); else stop it.
  const stop = page.getByTestId('chat-stop');
  if (await stop.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await stop.click().catch(() => undefined);
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 30_000 });
}

/** Commits changes to the remote like Obsidian would: `null` deletes the file. */
function pushChanges(bare: string, changes: Record<string, string | null>) {
  const work = mkdtempSync(join(tmpdir(), 'e2e-cmds-'));
  try {
    git(work, 'clone', '-q', bare, '.');
    for (const [p, c] of Object.entries(changes)) {
      if (c === null) git(work, 'rm', '-q', p);
      else {
        mkdirSync(dirname(join(work, p)), { recursive: true });
        writeFileSync(join(work, p), c);
      }
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-qm', 'e2e: legacy layout');
    git(work, 'push', '-q', 'origin', 'main');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // pushFromObsidian keeps the bare repo writable for the backend container; reuse it for that.
  pushFromObsidian(bare, '.e2e-touch', String(Date.now()));
}

test('/ lists the vault\'s commands; picking fills the composer', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await newChat(page);
  const composer = page.getByTestId('chat-composer');
  await composer.fill('/');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  const hello = palette.getByTestId('command-group-vault').locator('[data-command="hello"]');
  await expect(hello).toContainText('/hello');
  await expect(hello).toContainText('Says hello to the user');
  await expect(hello.locator('.cmd-tag')).toHaveText('vault');
  await expect(palette.getByTestId('command-group-vault')).toContainText('This vault');
  const research = palette.getByTestId('command-group-app').locator('[data-command="research"]');
  await expect(research.locator('.cmd-tag')).toHaveText('app');
  await expect(palette.getByTestId('command-group-app')).toContainText('karpathy.app');
  await composer.fill('/he');
  await expect(palette.locator('[role="option"]')).toHaveCount(1);
  await composer.press('ArrowDown');
  await composer.press('Enter');
  await expect(composer).toHaveValue('/hello ');
  await expect(palette).toBeHidden();
  await composer.fill('/');
  await expect(palette).toBeVisible();
  await composer.press('Escape');
  await expect(palette).toBeHidden();
  // Nothing was sent.
  await expect(page.locator('.msgs .u')).toHaveCount(0);
});

test('a replacing vault skill is flagged', async ({ page, api, vault }) => {
  pushFromObsidian(vault.bare, '.agents/skills/research/SKILL.md', '---\nname: research\ndescription: My own research\n---\n\nMine.\n');
  // The pull on open is skipped when the lock is busy; this test is about the palette, so pull first.
  expect((await api.ctx.post(`/api/vaults/${vault.id}/pull`)).ok()).toBe(true);
  await openApp(page, vault.id);
  await newChat(page);
  await page.getByTestId('chat-composer').fill('/res');
  const row = page.getByTestId('command-palette').getByTestId('command-group-vault').locator('[data-command="research"]');
  await expect(row.locator('.cmd-tag')).toHaveText('vault');
  await expect(row).toContainText("Replaces karpathy.app's /research");
});

test('a chip fills the composer', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await newChat(page);
  const chip = page.getByTestId('command-chip').filter({ hasText: '/hello' });
  await expect(chip).toBeVisible();
  await expect(page.getByTestId('command-chip').filter({ hasText: '/research' })).toHaveAttribute('title', /built into karpathy\.app/);
  await expect(page.getByTestId('command-chip').filter({ hasText: '/research' }).locator('img')).toBeVisible();
  const composer = page.getByTestId('chat-composer');
  await chip.click();
  await expect(composer).toHaveValue('/hello ');
  await expect(composer).toBeFocused();
  await expect(page.locator('.msgs .u')).toHaveCount(0);
  await composer.fill('what is X');
  await chip.click();
  await expect(composer).toHaveValue('/hello what is X');
  await sendAndStop(page);
  await expect(page.getByTestId('command-chips')).toHaveCount(0);
});

test('chips that arrive late don\'t move the message list', async ({ page, vault }) => {
  // Hold the command list back until the list is scrolled (a fresh vault's first listing is slow).
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/vaults/*/commands', async (route) => {
    await held;
    await route.continue();
  });
  await openApp(page, vault.id);
  await newChat(page);
  // The chip row's space is kept while loading: a list kept at its end would otherwise jump when they come.
  const column = page.locator('#chat [role="region"][aria-label="Messages"] > .msgs');
  const height = () => column.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const before = await height();
  release();
  await expect(page.getByTestId('command-chip').first()).toBeVisible();
  expect(await height()).toBe(before);
});

test('last used comes first', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await newChat(page);
  await expect(page.getByTestId('command-chip').first()).toHaveText('/hello');
  await page.getByTestId('chat-composer').fill('/research x');
  await sendAndStop(page);
  await page.getByTestId('chat-back').click();
  await expect(page.getByTestId('chat-item').first()).toBeVisible();
  await newChat(page);
  await expect(page.getByTestId('command-chip').first()).toHaveText('/research');
});

test('opening a .claude vault moves it and says so', async ({ page, vault }) => {
  pushChanges(vault.bare, { 'AGENTS.md': null, 'CLAUDE.md': '# Rules\n\nKeep it short.\n', '.claude/commands/greet.md': '---\ndescription: Greets\n---\nGreet $ARGUMENTS.\n' });
  await openApp(page, vault.id);
  const notice = page.getByTestId('agents-move');
  await expect(notice).toContainText('Moved to the .agents standard');
  await page.screenshot({ path: test.info().outputPath('move-notice.png') });
  await notice.getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('[data-testid="change-item"][data-path="AGENTS.md"]')).toBeVisible();
  await expect(page.locator('[data-testid="change-item"][data-path=".agents/skills/greet/SKILL.md"]')).toBeVisible();
  await newChat(page);
  await page.getByTestId('chat-composer').fill('/');
  await expect(page.getByTestId('command-palette').locator('[data-command="greet"]')).toBeVisible();
  // Shown once: a reload doesn't bring the same move back.
  await page.reload();
  await expect(page.getByTestId('vault-switcher').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('agents-move')).toHaveCount(0);
});

test('a clash is listed in the notice', async ({ page, vault }) => {
  // AGENTS.md exists (fixture) and CLAUDE.md is not the pointer: nothing to paste into, a clash.
  pushChanges(vault.bare, { 'CLAUDE.md': '# Other rules\n', '.claude/skills/hello/SKILL.md': '---\nname: hello\ndescription: old\n---\nOld.\n' });
  await openApp(page, vault.id);
  await expect(page.getByTestId('agents-move')).toContainText('not moved, name exists: AGENTS.md, hello');
});

test('@iphone the palette fits above the composer', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await newChat(page);
  await page.getByTestId('chat-composer').fill('/');
  const palette = page.getByTestId('command-palette');
  await expect(palette.locator('[data-command="research"]')).toBeVisible();
  const box = (await palette.boundingBox())!;
  const comp = (await page.getByTestId('chat-composer').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(comp.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await palette.screenshot({ path: test.info().outputPath('palette-390.png'), scale: 'css' });
});

test('@iphone the move notice fits and Review is tappable', async ({ page, vault }) => {
  pushChanges(vault.bare, { 'CLAUDE.md': '# Other rules\n', '.claude/commands/greet.md': 'Greet $ARGUMENTS.\n' });
  await openApp(page, vault.id);
  const notice = page.getByTestId('agents-move');
  await expect(notice).toContainText('Moved to the .agents standard');
  const box = (await notice.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await notice.screenshot({ path: test.info().outputPath('notice-390.png'), scale: 'css' });
  await page.screenshot({ path: test.info().outputPath('notice-390-page.png'), scale: 'css' });
  // The notice must not cover the header's controls (it once hid the Settings gear).
  await page.getByTestId('open-settings').click({ trial: true, timeout: 3000 });
  await notice.getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('[data-testid="change-item"][data-path=".agents/skills/greet/SKILL.md"]')).toBeVisible();
});

test('@ipad the move notice leaves the header and the chat composer free', async ({ page, vault }) => {
  pushChanges(vault.bare, { 'CLAUDE.md': '# Other rules\n', '.claude/commands/greet.md': 'Greet $ARGUMENTS.\n' });
  await openApp(page, vault.id);
  await expect(page.getByTestId('agents-move')).toBeVisible();
  await newChat(page);
  await page.getByTestId('chat-composer').click({ trial: true, timeout: 3000 });
  await page.getByTestId('new-chat').click({ trial: true, timeout: 3000 });
  await page.screenshot({ path: test.info().outputPath('notice-ipad.png'), scale: 'css' });
});
