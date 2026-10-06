import type { Page } from '@playwright/test';
import { backendExec, expect, openApp, test } from './helpers';

// Sort and filter the file tree (#122). Folders start collapsed, so the visible file rows are the
// vault root's files: AGENTS.md, Home.md, Ideas.md, all from the same seed commit.
const rootFiles = (page: Page) => page.locator('[data-testid="tree-item"][data-type="file"]');
const sortButton = (page: Page) => page.getByTestId('tree-sort');
const item = (page: Page, name: string | RegExp) => page.getByRole('menuitemradio', { name });

test.describe('tree sort and filter', () => {
  test('sort menu sets criterion and direction, and is remembered', async ({ page, api, vault }) => {
    // Uncommitted now, so newer than the seed commit.
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nchanged\n');
    await openApp(page, vault.id);
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['AGENTS.md', 'Home.md', 'Ideas.md']);
    await expect(sortButton(page)).not.toHaveClass(/\bon\b/);

    await sortButton(page).click();
    await expect(item(page, 'A → Z')).toHaveAttribute('aria-checked', 'true');
    await expect(item(page, 'Z → A')).toBeVisible();
    await item(page, 'Last changed').click();
    await expect(item(page, 'Newest first')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['Ideas.md', 'AGENTS.md', 'Home.md']);
    await item(page, 'Oldest first').click();
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['AGENTS.md', 'Home.md', 'Ideas.md']);
    await item(page, 'Name').click();
    await expect(item(page, 'A → Z')).toHaveAttribute('aria-checked', 'true');
    await item(page, 'Last changed').click();
    await page.keyboard.press('Escape');
    await expect(item(page, 'Newest first')).toHaveCount(0);
    await expect(sortButton(page)).toHaveClass(/\bon\b/);

    await page.reload();
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['Ideas.md', 'AGENTS.md', 'Home.md']);
    await expect(sortButton(page)).toHaveClass(/\bon\b/);
  });

  test('a save elsewhere moves the note up without a reload', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await expect(rootFiles(page)).toHaveCount(3);
    // Modified while sorted by name (no refetch needed then): switching to Last changed must use fresh dates.
    await api.write(vault.id, 'Home.md', '# Home\n\nfrom another tab\n');
    await page.waitForTimeout(1500); // the change event has arrived and been handled
    await sortButton(page).click();
    await item(page, 'Last changed').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['Home.md', 'AGENTS.md', 'Ideas.md']);
    // An existing file modified elsewhere (another tab, the AI): no new path, so today's tree doesn't refetch.
    await page.waitForTimeout(1100); // mtimes must differ
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nfrom another tab\n');
    await expect.poll(() => rootFiles(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['Ideas.md', 'Home.md', 'AGENTS.md']);
  });

  test('a filtered-out open note does not expand its folders', async ({ page, vault }) => {
    // Written behind the app's back and never committed: no human (or AI) date, so the Human filter hides it.
    backendExec('sh', '-c', `printf '# Ghost\\n' > /vaults/${vault.id}/wiki/ghost.md`);
    await openApp(page, vault.id);
    await page.getByTestId('tree-filter').click();
    await item(page, 'Human').click();
    const wiki = page.locator('[data-testid="tree-item"][data-path="wiki"]');
    await expect(wiki).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate((id) => { location.hash = `#/${id}/wiki/ghost.md`; }, vault.id);
    await expect(page.locator('.note-title')).toHaveText('ghost');
    await expect(page.locator('[data-testid="tree-item"][data-path="wiki/ghost.md"]')).toHaveCount(0);
    await expect(wiki).toHaveAttribute('aria-expanded', 'false');
  });

  // Real model turn (dev: local Ollama), so long timeouts; assertions on chips and the tree, never answer text.
  test('@llm filter by AI shows only AI files, with a chip that resets it', async ({ page, vault }) => {
    test.setTimeout(30 * 60_000);
    const reminder = page.getByTestId('reminder-dialog');
    await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
    await openApp(page, vault.id);
    const chip = page.getByTestId('tree-filter-chip');
    await expect(chip).toHaveCount(0);
    await page.getByTestId('tree-filter').click();
    await item(page, 'AI').click();
    await expect(item(page, 'AI')).toHaveCount(0); // closes on choice
    await expect(page.getByTestId('tree-filter')).toHaveClass(/\bon\b/);
    await expect(chip).toContainText('Changed by AI');
    await expect(page.locator('.tree .empty')).toHaveText(/No notes changed by the AI yet/);

    await page.getByTestId('new-chat').click();
    const written = page.locator('[data-testid="tool-chip"][data-writes="true"][data-status="completed"][data-path$="ai-only.md"]');
    for (const prompt of [
      'Use the write tool to create the file ai-only.md with exactly this content: "# AI only". Do nothing else.',
      'Call the write tool now: filePath "ai-only.md", content "# AI only".',
    ]) {
      await page.getByTestId('chat-composer').fill(prompt);
      await page.getByTestId('chat-send').click();
      await expect(page.getByTestId('chat-stop')).toBeVisible();
      await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 8 * 60_000 });
      if (await written.count()) break;
    }
    await expect(written).toBeVisible();

    // The filter survives a reload; the tree shows the AI's file and none of the seed notes.
    await page.reload();
    await expect(chip).toContainText('Changed by AI');
    await expect(page.locator('[data-testid="tree-item"][data-path="ai-only.md"]')).toBeVisible();
    await expect(page.locator('[data-testid="tree-item"][data-path="Home.md"]')).toHaveCount(0);

    await chip.getByRole('button', { name: 'Clear filter' }).click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator('[data-testid="tree-item"][data-path="Home.md"]')).toBeVisible();
    await expect(page.getByTestId('tree-filter')).not.toHaveClass(/\bon\b/);
  });
});
