import type { Page } from '@playwright/test';
import { expect, openApp, openNote, revealInTree, test, treeItem } from './helpers';

// The ‹ back arrow in the note header (#139): browser Back as a button, shown only while the previous
// history entry is a file of this vault.

const tap = (page: Page, sel: string) => (test.info().project.name.includes('iphone') ? page.getByTestId(sel).tap() : page.getByTestId(sel).click());

async function linkAndBack(page: Page) {
  await openNote(page, 'Home.md');
  await expect(page.getByTestId('note-back')).toHaveCount(0);
  await page.locator('.cm-wl[data-target="Ideas"]').click();
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await expect(page.getByTestId('note-back')).toBeVisible();
  await expect(page.getByTestId('note-back')).toHaveAttribute('title', 'Back to Home.md');

  // Write ↔ Read keeps it.
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('note-back')).toBeVisible();
  await page.getByTestId('mode-write').click();

  await tap(page, 'note-back');
  await expect(page.locator('.note-title')).toHaveText('Home');
  await expect(page.getByTestId('note-back')).toHaveCount(0);
}

test('A → wikilink → B, the arrow returns to A, then hides', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await linkAndBack(page);
});

test('@iphone A → wikilink → B, the arrow returns to A, then hides', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await linkAndBack(page);
});

test('note → image → the arrow returns to the note', async ({ page, api, vault }) => {
  await api.write(vault.id, 'pic.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  await revealInTree(page, 'pic.svg');
  await treeItem(page, 'pic.svg').click();
  await expect(page.locator('.note-title')).toHaveText('pic.svg');
  await page.getByTestId('note-back').click();
  await expect(page.locator('.note-title')).toHaveText('Home');
});

test('no arrow when a deep link is opened in a new tab', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const tab = await page.context().newPage();
  await tab.goto(`/#/${vault.id}/Ideas.md`);
  await expect(tab.locator('.note-title')).toHaveText('Ideas');
  await expect(tab.getByTestId('note-back')).toHaveCount(0);
  await tab.close();
});

test('@iphone with the arrow the note header still fits the phone width', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await treeItem(page, 'Home.md').click();
  await page.locator('.cm-wl[data-target="Ideas"]').tap();
  await expect(page.getByTestId('note-back')).toBeVisible();
  const width = page.viewportSize()!.width;
  for (const id of ['delete-note', 'note-back', 'back']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(width);
  }
  // The chat is the tab bar's Chat tab on the phone, not a header button.
  await expect(page.getByTestId('chat-toggle')).toHaveCount(0);
  await expect(page.getByTestId('tab-chat')).toBeVisible();
  await expect(page.getByTestId('back')).toHaveAttribute('aria-label', 'Files');
});

test('@iphone the phone back button still leaves the note', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const app = page.locator('#app');
  await treeItem(page, 'Home.md').click();
  await page.locator('.cm-wl[data-target="Ideas"]').tap();
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await expect(page.getByTestId('note-back')).toBeVisible();
  await page.getByTestId('back').tap();
  await expect(app).toHaveAttribute('data-sb', 'cur');
});
