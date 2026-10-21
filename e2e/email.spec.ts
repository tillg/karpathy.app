import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openApp, openNote, pushFromObsidian, revealInTree, ROOT, test, treeItem, type TestVault } from './helpers';

// Emails (#166): an .eml shows as a mail, read-only. Synthetic fixtures, pushed as bytes (latin1.eml isn't UTF-8).

const fixture = (name: string) => readFileSync(join(ROOT, 'apps/web/src/lib/fixtures', name));

function seed(vault: TestVault) {
  for (const name of ['alternative.eml', 'related.eml', 'latin1.eml']) pushFromObsidian(vault.bare, `Mail/${name}`, fixture(name));
}

async function openMail(page: Page, name: string, subject: string) {
  await revealInTree(page, `Mail/${name}`);
  await treeItem(page, `Mail/${name}`).click();
  await expect(page.locator('.note-title')).toHaveText(subject);
}

test('a .eml opens as a mail: subject, header block, body in a sandboxed frame, no mode toggle', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'alternative.eml', 'Notes on the Analytical Engine');
  await expect(page.getByTestId('email-subject')).toBeVisible();
  const head = page.getByTestId('email-head');
  await expect(head).toContainText('Ada Lovelace <ada@example.org>');
  await expect(head).toContainText('Charles Babbage <charles@example.org>, team@example.org');
  await expect(head).toContainText('Mary Somerville <mary@example.org>');
  const frame = page.getByTestId('email-body');
  expect(await frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin/);
  const f = page.frameLocator('[data-testid="email-body"]');
  await expect(f.locator('h1')).toHaveText('Notes');
  await expect(f.locator('script')).toHaveCount(0);
  await expect(f.locator('a', { hasText: 'Engine' })).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('mode-write')).toHaveCount(0);
  await expect(page.getByTestId('find-in-note')).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByTestId('delete-note')).toBeVisible();
});

test('the inline image shows and the remote one is a link', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'related.eml', 'Report with a picture');
  const f = page.frameLocator('[data-testid="email-body"]');
  await expect.poll(() => f.locator('img[alt="dot"]').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(f.locator('a[href="https://example.com/track.png"]')).toHaveText('tracker');
  await expect(f.locator('img')).toHaveCount(1);
});

test('tapping an attachment downloads it', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'related.eml', 'Report with a picture');
  const atts = page.getByTestId('email-attachment');
  await expect(atts).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), atts.first().click()]);
  expect(download.suggestedFilename()).toBe('report.pdf');
});

test('a Latin-1 mail shows decoded, not as a binary file', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'latin1.eml', 'Grüße aus Köln');
  await expect(page.getByTestId('email-head')).toContainText('Jürgen Müller <juergen@example.org>');
  // toHaveText(string) would ignore a lost line break.
  await expect.poll(() => page.getByTestId('email-text').evaluate((e) => e.textContent)).toBe('Grüße aus Köln.\nDas Wetter ist schön.\n');
  await expect(page.getByTestId('binary-file')).toHaveCount(0);
});

test('a search hit in a mail opens the mail', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await page.getByTestId('section-search').click();
  await page.getByTestId('search-input').fill('Analytical Engine');
  await page.locator('[data-testid="search-result"][data-path="Mail/alternative.eml"]').click();
  await expect(page.locator('.note-title')).toHaveText('Notes on the Analytical Engine');
  await expect(page.frameLocator('[data-testid="email-body"]').locator('h1')).toHaveText('Notes');
});

test('the next note after a mail opens as before', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'alternative.eml', 'Notes on the Analytical Engine');
  await openNote(page, 'Home.md');
  await expect(page.getByTestId('mode-write')).toBeVisible();
  await expect(page.getByTestId('email-head')).toHaveCount(0);
});

test('@iphone a mail opens on the phone', async ({ page, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openMail(page, 'related.eml', 'Report with a picture');
  await expect(page.getByTestId('email-head')).toContainText('Grace Hopper');
  await expect(page.frameLocator('[data-testid="email-body"]').locator('img[alt="dot"]')).toHaveCount(1);
  await expect(page.getByTestId('email-attachment')).toBeVisible();
});
