import type { Locator } from '@playwright/test';
import { expect, openApp, openSettings, openVaults, test, treeItem } from './helpers';

/** On screen horizontally (panes slide in/out with transforms; IntersectionObserver is unreliable here). */
async function expectOnScreen(l: Locator) {
  await expect.poll(async () => {
    const b = await l.boundingBox();
    const w = l.page().viewportSize()!.width;
    return !!b && b.width > 0 && b.x >= 0 && b.x + b.width <= w + 1;
  }, { message: 'element on screen' }).toBe(true);
}

test.describe('phone layout', () => {
  test('@iphone tab bar, push navigation, changes badge, chat tab', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    const app = page.locator('#app');
    await expect(app).toHaveClass(/phone/);
    for (const t of ['files', 'search', 'chat', 'changes']) await expect(page.getByTestId(`tab-${t}`)).toBeVisible();
    await expect(page.getByTestId('tab-files')).toHaveClass(/on/);
    await expect(app).toHaveAttribute('data-sb', 'cur');
    await expect(page.getByTestId('sidebar-sections')).toHaveCount(0);

    // Files → note is pushed over the tab root; Back pops it.
    await treeItem(page, 'Home.md').click();
    await expect(app).toHaveAttribute('data-dt', 'cur');
    await expectOnScreen(page.locator('#detail .cm-content'));
    await expect(page.locator('.cm-content')).toContainText('Welcome to the test vault');
    await expect(page.getByTestId('back')).toContainText('Files');
    await page.screenshot({ path: test.info().outputPath('phone-note.png') });
    await page.getByTestId('back').click();
    await expect(app).toHaveAttribute('data-sb', 'cur');
    await expectOnScreen(treeItem(page, 'Home.md'));

    // Changes badge on the tab bar follows the event stream.
    await expect(page.getByTestId('changes-badge-tab')).toHaveCount(0);
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nphone edit\n');
    await expect(page.getByTestId('changes-badge-tab')).toHaveText('1');
    await page.getByTestId('tab-changes').click();
    await expectOnScreen(page.locator('[data-testid="change-item"][data-path="Ideas.md"]'));

    // Chat tab.
    await page.getByTestId('tab-chat').click();
    await expect(app).toHaveAttribute('data-ch', 'cur');
    await expectOnScreen(page.getByTestId('new-chat'));
    await page.screenshot({ path: test.info().outputPath('phone-chat.png') });
  });

  // Bug #2: opening a search hit (note opens at a line) scrolls #app sideways; stays shifted after Back.
  test('@iphone admin views fit 375px without horizontal scroll', async ({ page, vault }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await openApp(page, vault.id);
    await openVaults(page);
    const admin = page.getByTestId('admin');
    const fits = async (label: string, dialog = admin) => {
      const body = dialog.locator('.modal-body');
      await expect.poll(() => body.evaluate((e) => e.scrollWidth <= e.clientWidth), { message: `${label}: no horizontal scroll` }).toBe(true);
      const b = await dialog.boundingBox();
      expect(b!.x >= 0 && b!.x + b!.width <= 375 + 1, `${label}: dialog inside the viewport`).toBe(true);
      await page.screenshot({ path: `tmp/08/phone-${label}.png`, scale: 'css' });
    };
    await expect(admin.getByTestId('admin-vault').first()).toBeVisible();
    await fits('list');
    await admin.locator(`[data-testid="admin-vault"][data-vault="${vault.id}"]`).click();
    await admin.getByTestId('vault-edit').click();
    await fits('details');
    await admin.getByRole('button', { name: 'Close', exact: true }).click();
    await openSettings(page);
    const settings = page.getByTestId('settings-dialog');
    await settings.getByTestId('token-test').click();
    await expect(settings.getByTestId('token-result')).toBeVisible({ timeout: 20_000 });
    await fits('settings', settings);
    await settings.getByTestId('version-server').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'tmp/08/phone-settings-bottom.png', scale: 'css' });
  });

  test('@iphone search tab: open a hit, Back returns to the unshifted search list', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const app = page.locator('#app');
    // Intermittent (timing of the pane transition), so repeat the round trip a few times.
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('tab-files').click();
      await treeItem(page, 'Home.md').click();
      await expect(app).toHaveAttribute('data-dt', 'cur');
      await page.getByTestId('back').click();
      await expect(app).toHaveAttribute('data-sb', 'cur');
      await page.getByTestId('tab-search').click();
      await page.getByTestId('search-input').fill('unicode check');
      await page.locator('[data-testid="search-result"][data-path="Home.md"]').click();
      await expect(app).toHaveAttribute('data-dt', 'cur');
      await expect(page.getByTestId('back')).toContainText('Search');
      await page.getByTestId('back').click();
      await expect(app).toHaveAttribute('data-sb', 'cur');
      await page.waitForTimeout(600); // let the slide transition finish
      expect(await app.evaluate((e) => e.scrollLeft), `#app scrolled sideways (round ${i + 1})`).toBe(0);
    }
  });
});

test.describe('tablet layout', () => {
  test('@ipad sidebar overlay, note fills the screen, chat overlay', async ({ page, vault }) => {
    await openApp(page, vault.id);
    const app = page.locator('#app');
    await expect(app).toHaveClass(/tablet/);
    await expect(page.locator('#tabbar')).toHaveCount(0);
    // Sidebar hidden by default on tablets; the toggle opens it as an overlay.
    await expect(app).not.toHaveClass(/sbopen/);
    await page.getByTestId('sidebar-toggle').click();
    await expect(app).toHaveClass(/sbopen/);
    await expectOnScreen(treeItem(page, 'Home.md'));
    await treeItem(page, 'Home.md').click();
    // Opening a note closes the overlay.
    await expect(app).not.toHaveClass(/sbopen/);
    await expect(page.locator('.note-title')).toHaveText('Home');
    await expect(page.locator('#detail').getByTestId('changes-badge')).toBeVisible(); // small git pill in the note bar
    await page.screenshot({ path: test.info().outputPath('ipad-note.png') });

    await page.getByTestId('chat-toggle').click();
    await expect(app).toHaveClass(/insp/);
    await expectOnScreen(page.getByTestId('new-chat'));
    await page.locator('#scrim').click({ position: { x: 20, y: 600 } });
    await expect(app).not.toHaveClass(/insp/);
  });
});
