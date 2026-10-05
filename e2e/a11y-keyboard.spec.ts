import type { Page } from '@playwright/test';
import { expect, makeConflict, openApp, openNote, openVaults, test, treeItem } from './helpers';

// Keyboard and screen-reader behaviour (issues #39, #43, #44, #45, #46, #47).

const focusInDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]'));

/** Tab / Shift+Tab `n` times each; focus must never leave the dialog. */
async function expectTabTrapped(page: Page, n = 8) {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      expect(await focusInDialog(page), `${key} #${i + 1} stays in the dialog`).toBe(true);
    }
  }
}

test.describe('keyboard and screen readers', () => {
  test('commit dialog: modal, focus moves in, Tab trapped, background inert, Escape returns focus (#39)', async ({ page, api, vault }) => {
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged\n');
    await openApp(page, vault.id);
    await page.getByTestId('section-changes').click();
    const opener = page.getByTestId('commit-button');
    await expect(opener).toBeEnabled();
    await opener.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Commit & Push' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(await focusInDialog(page)).toBe(true);
    // Once the proposed message is in, focus is in the message field.
    await expect(page.getByTestId('commit-message')).toBeFocused({ timeout: 30_000 });
    await expect(page.locator('#root')).toHaveJSProperty('inert', true);
    await expectTabTrapped(page);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  });

  test('vault menu: arrows, Home/End, Escape; admin opened from it returns focus to the trigger (#39, #43)', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const trigger = page.getByTestId('vault-switcher');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = page.getByRole('menuitem');
    const n = await items.count();
    expect(n).toBeGreaterThanOrEqual(2);
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('manage-vaults')).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps back
    await expect(page.getByTestId('manage-vaults')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // ArrowUp on the trigger opens on the last item; Enter opens the admin dialog.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('manage-vaults')).toBeFocused();
    await page.keyboard.press('Enter');
    const admin = page.getByRole('dialog', { name: 'Vaults', exact: true });
    await expect(admin).toBeVisible();
    await expect(admin.getByRole('heading', { name: 'Vaults', exact: true })).toBeFocused();
    await expectTabTrapped(page, 12);
    await page.keyboard.press('Escape');
    await expect(admin).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('conflict choice is a radio group; compare dialog focuses the chosen side (#44)', async ({ page, api, vault }) => {
    await makeConflict(api, vault);
    await openApp(page, vault.id);
    await page.getByTestId('section-changes').click();
    const item = page.locator('[data-testid="conflict-item"][data-path="Ideas.md"]');
    const group = item.getByRole('radiogroup', { name: 'Resolution for Ideas.md' });
    await expect(group).toBeVisible();
    const radio = (name: string) => group.getByRole('radio', { name });
    await expect(radio('Keep both')).toHaveAttribute('aria-checked', 'true');
    await expect(radio('Keep mine')).toHaveAttribute('aria-checked', 'false');
    // Only the checked radio is a Tab stop.
    await expect(radio('Keep both')).toHaveAttribute('tabindex', '0');
    await expect(radio('Keep mine')).toHaveAttribute('tabindex', '-1');

    await radio('Keep both').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(radio('Keep theirs')).toBeFocused();
    await expect(radio('Keep theirs')).toHaveAttribute('aria-checked', 'true');
    await expect(radio('Keep both')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(radio('Keep mine')).toBeFocused();
    await expect(radio('Keep mine')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('End');
    await expect(radio('Keep both')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(radio('Keep mine')).toHaveAttribute('aria-checked', 'true');

    const compare = item.getByTestId('conflict-compare');
    await expect(compare).toBeEnabled(); // once both sides are loaded
    await compare.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Ideas.md' });
    await expect(dialog.getByRole('radio', { name: 'Keep mine' })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: 'Keep mine' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(compare).toBeFocused();
  });

  test('file tree exposes folder state and the open note; landmarks and heading (#44, #47)', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const folder = treeItem(page, 'wiki');
    await expect(folder).toHaveAttribute('aria-expanded', 'false'); // collapsed by default (#53)
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await folder.click();
    await openNote(page, 'Home.md');
    await expect(treeItem(page, 'Home.md')).toHaveAttribute('aria-current', 'page');
    await expect(treeItem(page, 'Ideas.md')).not.toHaveAttribute('aria-current', /./);

    await expect(page.getByRole('main', { name: 'Note' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`karpathy.app — ${vault.id}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Home' })).toHaveCount(1);
  });

  test('chat: keyboard-scrollable message list and a polite live region (#45)', async ({ page, vault }) => {
    await openApp(page, vault.id);
    if (!(await page.locator('#chat').isVisible())) await page.getByTestId('chat-toggle').click();
    await page.getByTestId('new-chat').click();
    const list = page.getByRole('region', { name: 'Messages' });
    await expect(list).toHaveAttribute('tabindex', '0');
    await expect(page.getByTestId('chat-live')).toHaveAttribute('aria-live', 'polite');
    await list.focus();
    await expect(list).toBeFocused();
  });

  test('@ipad Escape closes the overlay sidebar and chat and returns focus to their toggles (#43)', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const app = page.locator('#app');
    await page.getByTestId('sidebar-toggle').click();
    await expect(app).toHaveClass(/sbopen/);
    await treeItem(page, 'Home.md').focus();
    await page.keyboard.press('Escape');
    await expect(app).not.toHaveClass(/sbopen/);
    await expect(page.getByTestId('sidebar-toggle')).toBeFocused();

    await page.getByTestId('chat-toggle').click();
    await expect(app).toHaveClass(/insp/);
    await page.keyboard.press('Escape');
    await expect(app).not.toHaveClass(/insp/);
    await expect(page.getByTestId('chat-toggle')).toBeFocused();
  });

  test('@iphone primary touch targets are at least 44px; reduced motion stops the slide (#46, #47)', async ({ page, api, vault }) => {
    const minSide = async (sel: ReturnType<Page['locator']>, label: string) => {
      // Measure after the dialog pop-in (a scale animation) has finished.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
      const b = await sel.first().boundingBox();
      expect(b, label).not.toBeNull();
      expect(Math.min(b!.width, b!.height), `${label}: ${b!.width}×${b!.height}`).toBeGreaterThanOrEqual(44);
    };
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged Wissen\n');
    await openApp(page, vault.id);

    await page.getByTestId('tab-search').click();
    await minSide(page.getByTestId('search-input'), 'search input');
    await page.getByTestId('search-input').fill('Wissen');
    await expect(page.getByTestId('search-result').first()).toBeVisible();
    await minSide(page.getByTestId('search-result'), 'search hit title');
    await minSide(page.locator('.hit .sn'), 'search hit line');

    await page.getByTestId('tab-changes').click();
    await minSide(page.getByTestId('commit-button'), 'Commit & Push');
    await minSide(page.getByTestId('change-item').locator('.chg-main'), 'change row');
    await page.getByTestId('commit-button').click();
    const commit = page.getByTestId('commit-dialog');
    await minSide(commit.getByRole('button', { name: 'Cancel' }), 'commit Cancel');
    await minSide(page.getByTestId('commit-submit'), 'commit submit');
    await minSide(commit.getByRole('button', { name: 'Close', exact: true }), 'commit Close');
    await page.keyboard.press('Escape');

    await page.getByTestId('tab-files').click();
    await treeItem(page, 'Home.md').click();
    await minSide(page.getByTestId('mode-write'), 'Write');
    await minSide(page.getByTestId('mode-read'), 'Read');
    await page.getByTestId('back').click();

    await openVaults(page);
    const admin = page.getByTestId('admin');
    await admin.getByTestId('admin-vault').first().click();
    await minSide(admin.getByTestId('vault-edit'), 'admin Edit');
    await minSide(admin.getByTestId('vault-remove'), 'admin Remove');
    await minSide(admin.getByRole('button', { name: 'Close', exact: true }), 'admin Close');
    await page.keyboard.press('Escape');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const duration = await page.locator('#detail').evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration));
    expect(duration).toBeLessThan(0.01);
  });
});
