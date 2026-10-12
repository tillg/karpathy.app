import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openApp, openNote, pushFromObsidian, revealInTree, ROOT, test, treeItem, type TestVault } from './helpers';

// HTML pages (#126): Read = the page rendered in a sandboxed frame, Write = its source; their own sticky mode.


const PAGE = `<!doctype html><html><head><title>Report</title>
<style>h1 { color: rgb(200, 0, 0); }</style><link rel="stylesheet" href="page.css">
<script>document.title = 'scripted'; window.parent.postMessage('ran', '*');</script></head>
<body><h1>Report title</h1><p class="note">Styled by the vault's stylesheet.</p>
<img src="dot.png" alt="dot"><p><a href="../Ideas.md">Ideas</a> · <a href="https://example.com/">Example</a></p>
<form><input name="q"></form></body></html>`;

/** Pushed "from Obsidian" before the app opens the vault (the open pulls them). */
function seed(vault: TestVault) {
  pushFromObsidian(vault.bare, 'Reports/page.html', PAGE);
  pushFromObsidian(vault.bare, 'Reports/page.css', 'p.note { color: rgb(0, 128, 0); }');
  pushFromObsidian(vault.bare, 'Reports/dot.png', readFileSync(join(ROOT, 'e2e/fixtures/media/dot.png')));
}

async function openPage(page: Page) {
  await revealInTree(page, 'Reports/page.html');
  await treeItem(page, 'Reports/page.html').click();
  await expect(page.locator('.note-title')).toHaveText('page.html');
}

test('an HTML page opens in Read: its own styles, a vault image, no scripts, no forms', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openPage(page);
  await expect(page.getByTestId('mode-read')).toHaveAttribute('aria-pressed', 'true');
  const frame = page.getByTestId('html-view');
  await expect(frame).toHaveAttribute('sandbox', /allow-popups/);
  expect(await frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin/);
  const f = page.frameLocator('[data-testid="html-view"]');
  await expect(f.locator('h1')).toHaveText('Report title');
  await expect(f.locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');
  await expect(f.locator('p.note')).toHaveCSS('color', 'rgb(0, 128, 0)');
  await expect.poll(() => f.locator('img[alt="dot"]').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(f.locator('form, script')).toHaveCount(0);
  await expect(f.locator('a', { hasText: 'Example' })).toHaveAttribute('target', '_blank');
});

test('Write shows the source; the page mode is separate from the notes\' mode', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-pressed', 'true');

  await openPage(page);
  await expect(page.getByTestId('html-view')).toBeVisible();
  await page.getByTestId('mode-write').click();
  await expect(page.locator('.cm-content')).toContainText('<h1>Report title</h1>');
  await expect.poll(() => page.locator('.cm-line span', { hasText: /^h1$/ }).first().getAttribute('class')).toBeTruthy();

  // Back to Read on the page; the next note still opens in Write.
  await page.getByTestId('mode-read').click();
  await treeItem(page, 'Ideas.md').click();
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-pressed', 'true');
  // And the page opens in Read again.
  await openPage(page);
  await expect(page.getByTestId('html-view')).toBeVisible();
});

test('a link to a vault note in the page opens it in the app; the back arrow returns', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openPage(page);
  await page.frameLocator('[data-testid="html-view"]').locator('a', { hasText: 'Ideas' }).click();
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await page.getByTestId('note-back').click();
  await expect(page.locator('.note-title')).toHaveText('page.html');
});

test('a search hit in a page opens its source; the page mode stays Read', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await page.getByTestId('section-search').click();
  await page.getByTestId('search-input').fill('Styled by the vault');
  const row = page.locator('[data-testid="search-result"][data-path="Reports/page.html"]').locator('..').locator('.sn').first();
  await row.click();
  await expect(page.locator('.note-title')).toHaveText('page.html');
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-content')).toContainText('Styled by the vault');
  // Switching to Read works; the next page opens in Read (the preference never changed).
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('html-view')).toBeVisible();
  await page.getByTestId('section-files').click();
  await treeItem(page, 'Ideas.md').click();
  await openPage(page);
  await expect(page.getByTestId('mode-read')).toHaveAttribute('aria-pressed', 'true');
});

test('@iphone an HTML page opens in Read on the phone', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openPage(page);
  await expect(page.frameLocator('[data-testid="html-view"]').locator('h1')).toHaveText('Report title');
});
