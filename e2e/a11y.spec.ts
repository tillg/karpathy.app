import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, makeConflict, makePlainRemote, openApp, openNote, openSettings, openVaults, pushFromObsidian, runId, test, uid } from './helpers';

// Automated WCAG 2.1 A/AA + best-practice scan (axe-core) of the main screens, light and dark
// (issues #39–#47). Only serious/critical findings fail; moderate/minor best-practice rules
// (e.g. `region`) are reported by axe but not asserted.
//
// Deliberately excluded:
// - `.cm-content` (the CodeMirror editor): its contenteditable internals (dimmed `[[ ]]`/`#`
//   syntax markers, selection layers) are editor chrome, not page content; Read mode renders
//   the same note as HTML and is scanned instead.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

async function scan(page: Page, label: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // Let open/fade animations finish (axe would measure half-transparent colours); spinners loop forever.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
    const r = await new AxeBuilder({ page }).withTags(TAGS).exclude('.cm-content').analyze();
    const bad = r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`).join(' | ')}`);
    expect.soft(bad, `axe: ${label} (${colorScheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

test.describe('accessibility (axe)', () => {
  test('token screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('token-input')).toBeVisible();
    await scan(page, 'token screen');
  });

  test('desktop shell: note (write + read), search, changes, commit dialog, admin dialog, chat', async ({ page, api, vault }) => {
    await api.write(vault.id, 'Code.md', `# Code\n\nSee [[Home]].\n\n\`\`\`\n${'const wide = 1; '.repeat(30)}\n\`\`\`\n`);
    await openApp(page, vault.id);
    await openNote(page, 'Home.md');
    await scan(page, 'shell, Write mode');
    await page.getByTestId('outline-button').click();
    await expect(page.getByTestId('outline-item').first()).toBeVisible();
    await scan(page, 'outline, Write mode');
    await page.getByTestId('outline-button').click();

    // The properties form with a schema flag (#82).
    await api.write(vault.id, 'wiki/Flags.md', '---\ntype: concept\ntags: [a]\nupdated: 2026-10-02\nrelated: ["[[Home]]"]\nconfidence: very-high\n---\n# Flags\n');
    await openNote(page, 'wiki/Flags.md');
    await expect(page.getByTestId('props-violation')).toBeVisible();
    await scan(page, 'properties form');
    await openNote(page, 'Home.md');
    expect((await api.ctx.post(`/api/vaults/${vault.id}/discard?path=${encodeURIComponent('wiki/Flags.md')}`)).ok()).toBe(true); // the change counts below stay as they were

    await page.getByTestId('mode-read').click();
    await expect(page.getByTestId('read-view').locator('a.wl').first()).toBeVisible();
    await scan(page, 'Read mode');
    await page.getByTestId('outline-button').click();
    await expect(page.getByTestId('outline-item').first()).toBeVisible();
    await scan(page, 'outline, Read mode');
    await page.getByTestId('outline-button').click();
    // Wide code block: keyboard-scrollable (#45).
    await page.locator('[data-testid="tree-item"][data-path="Code.md"]').click();
    // Wait for Code.md to be open (the mode is sticky: it opens in Read mode, as Home.md was).
    await expect(page.getByRole('main', { name: 'Note' })).toContainText('Code.md');
    await page.getByTestId('mode-read').click();
    await expect(page.getByTestId('read-view').locator('pre')).toHaveAttribute('tabindex', '0');
    await scan(page, 'Read mode, code block');

    await page.getByTestId('section-search').click();
    await page.getByTestId('search-input').fill('Wissen');
    await expect(page.getByTestId('search-meta')).toBeVisible();
    await scan(page, 'search');

    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged\n');
    await page.getByTestId('section-changes').click();
    await expect(page.getByTestId('change-item')).toHaveCount(2);
    await page.getByTestId('change-item').first().locator('.chg-main').click();
    await expect(page.getByTestId('diff')).toBeVisible();
    await scan(page, 'changes');

    await page.getByTestId('commit-button').click();
    await expect(page.getByTestId('commit-message')).toBeEnabled({ timeout: 30_000 });
    await scan(page, 'commit dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('commit-dialog')).toBeHidden();

    await openVaults(page);
    await expect(page.getByTestId('admin-vault').first()).toBeVisible();
    await scan(page, 'admin dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('admin')).toBeHidden();

    if (!(await page.locator('#chat').isVisible())) await page.getByTestId('chat-toggle').click();
    await expect(page.locator('#chat')).toBeVisible();
    await scan(page, 'chat list');
    await page.getByTestId('new-chat').click();
    await expect(page.getByTestId('chat-messages')).toContainText('New chat');
    await scan(page, 'chat conversation');
  });

  test('incoming changes: pill segment, open-note bar, Changes banner and list', async ({ page, vault }) => {
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas from Obsidian\n');
    // Each connect of the event stream fetches; one that joins an earlier fetch may miss the push.
    await expect(async () => {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.getByTestId('incoming-note')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId('incoming-badge')).toBeVisible();
    await page.getByTestId('section-changes').click();
    await expect(page.getByTestId('incoming-list')).toBeVisible();
    await scan(page, 'incoming changes');
  });

  test('admin views: list, details, add with the missing-folders dialog, help dialog, settings', async ({ page, api, vault }) => {
    const plain = `e2e-a11y-plain-${runId()}-${uid()}`;
    makePlainRemote(plain);
    await openApp(page, vault.id);
    await openVaults(page);
    const admin = page.getByTestId('admin');
    await expect(admin.getByTestId('admin-vault').first()).toBeVisible();
    await scan(page, 'admin list');
    await admin.getByTestId('admin-help').click();
    await expect(page.getByTestId('vault-help')).toBeVisible();
    await scan(page, 'vault help dialog');
    await page.keyboard.press('Escape');
    await admin.locator(`[data-testid="admin-vault"][data-vault="${vault.id}"]`).click();
    await expect(admin.getByTestId('vault-details')).toBeVisible();
    await scan(page, 'vault details');
    await admin.getByTestId('admin-back').click();
    await admin.getByTestId('admin-open-add').click();
    await page.getByTestId('admin-repo').fill(`e2e/${plain}`);
    await page.getByTestId('admin-add').click();
    await expect(page.getByTestId('missing-folders')).toBeVisible();
    await scan(page, 'missing-folders dialog');
    await page.getByTestId('folders-cancel').click();
    expect((await api.vaults()).some((v) => v.repo === `e2e/${plain}`)).toBe(false);
    await admin.getByRole('button', { name: 'Close', exact: true }).click();
    await openSettings(page);
    const settings = page.getByTestId('settings-dialog');
    await settings.getByTestId('token-test').click();
    await expect(settings.getByTestId('token-result')).toBeVisible({ timeout: 20_000 });
    await scan(page, 'settings with token test result');
  });

  test('tree sort and filter menus, filter chip (#122)', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const sort = page.getByTestId('tree-sort');
    await expect(sort).toHaveAttribute('aria-haspopup', 'menu');
    await sort.click();
    await expect(sort).toHaveAttribute('aria-expanded', 'true');
    const radios = page.getByRole('menu', { name: 'Sort' }).getByRole('menuitemradio');
    await expect(radios).toHaveCount(4);
    await expect(page.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemradio', { name: 'Name' })).toBeFocused(); // focus lands on the checked item
    await scan(page, 'sort menu');
    await page.keyboard.press('Escape');
    await expect(sort).toBeFocused();
    await expect(sort).toHaveAttribute('aria-expanded', 'false');

    const filter = page.getByTestId('tree-filter');
    await filter.click();
    await expect(page.getByRole('menu', { name: 'Filter' }).getByRole('menuitemradio')).toHaveCount(3);
    await scan(page, 'filter menu');
    await page.getByRole('menuitemradio', { name: 'Human' }).click();
    await expect(filter).toBeFocused();
    await expect(page.getByTestId('tree-filter-chip')).toBeVisible();
    await scan(page, 'filter chip');
  });

  test('conflict view and the larger compare dialog', async ({ page, api, vault }) => {
    await makeConflict(api, vault);
    await openApp(page, vault.id);
    await page.getByTestId('section-changes').click();
    const item = page.locator('[data-testid="conflict-item"][data-path="Ideas.md"]');
    await expect(item).toContainText('# Ideas theirs');
    await scan(page, 'conflict view');
    await item.getByTestId('conflict-compare').click();
    await expect(page.getByTestId('conflict-compare-dialog')).toBeVisible();
    await scan(page, 'conflict compare dialog');
  });

  test('@iphone phone: files, note, search, changes, chat', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await scan(page, 'phone files');
    await page.locator('[data-testid="tree-item"][data-path="Home.md"]').click();
    await expect(page.locator('#app')).toHaveAttribute('data-dt', 'cur');
    await scan(page, 'phone note');
    await page.getByTestId('back').click();
    await page.getByTestId('tab-search').click();
    await page.getByTestId('search-input').fill('Wissen');
    await expect(page.getByTestId('search-meta')).toBeVisible();
    await scan(page, 'phone search');
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged\n');
    await page.getByTestId('tab-changes').click();
    await expect(page.getByTestId('change-item')).toHaveCount(1);
    await scan(page, 'phone changes');
    await page.getByTestId('tab-chat').click();
    await scan(page, 'phone chat');
  });
});
