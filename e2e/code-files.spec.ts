import type { Page } from '@playwright/test';
import { expect, openApp, openNote, revealInTree, test, treeItem } from './helpers';

// Text files that aren't notes (#126): code files get one view with syntax colors, .svg is an image.

async function openFile(page: Page, path: string) {
  await revealInTree(page, path);
  await treeItem(page, path).click();
  await expect(page.locator('.note-title')).toHaveText(path.split('/').pop()!);
}

const PY = 'def main():\n    print("[[Home]]")\n';

async function pythonFile(page: Page) {
  await openFile(page, 'scripts/run.py');
  await expect(page.locator('.cm-content')).toContainText('def main');
  await expect(page.getByTestId('mode-toggle')).toHaveCount(0);
  await expect(page.getByTestId('outline-button')).toHaveCount(0);
  await expect(page.getByTestId('attach')).toHaveCount(0);
  await expect(page.getByTestId('delete-note')).toHaveAttribute('title', 'Delete file');
  // Colored once the Python chunk has loaded; a wikilink in code stays text.
  await expect.poll(() => page.locator('.cm-line span', { hasText: /^def$/ }).first().getAttribute('class')).toBeTruthy();
  await expect(page.locator('.cm-wl')).toHaveCount(0);
}

test('a .py file is highlighted and has no Write/Read', async ({ page, api, vault }) => {
  await api.write(vault.id, 'scripts/run.py', PY);
  await openApp(page, vault.id);
  await pythonFile(page);
});

test('@iphone a .py file is highlighted and has no Write/Read', async ({ page, api, vault }) => {
  await api.write(vault.id, 'scripts/run.py', PY);
  await openApp(page, vault.id);
  await pythonFile(page);
});

test('a .txt file keeps single line breaks in Read mode, and Read stays for the next note', async ({ page, api, vault }) => {
  await api.write(vault.id, 'notes.txt', 'one\ntwo\nthree');
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('read-view')).toBeVisible();

  await openFile(page, 'notes.txt');
  await expect(page.locator('.cm-line')).toHaveCount(3);
  await expect(page.getByTestId('read-view')).toHaveCount(0);

  // Opening a code file didn't change the notes' mode.
  await treeItem(page, 'Ideas.md').click();
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await expect(page.getByTestId('mode-read')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('read-view')).toBeVisible();
});

test('an .svg shows as an image, not as text', async ({ page, api, vault }) => {
  await api.write(vault.id, 'pic.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
  await openApp(page, vault.id);
  await openFile(page, 'pic.svg');
  await expect(page.locator('.media-view img')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
});

test('a .md note is unchanged', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  await expect(page.getByTestId('mode-toggle')).toBeVisible();
  await expect(page.getByTestId('outline-button')).toBeVisible();
  await expect(page.locator('.cm-wl').first()).toBeVisible();
});
