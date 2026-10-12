import { expect, openApp, openNote, test } from './helpers';

// #147: URLs in frontmatter are links in Read mode and get an "open ↗" link next to the input in Write mode.
const NOTE = '---\ntrailer: https://example.com/watch?v=abc\nnote: plain text\n---\n# Film\n';

test('147 a frontmatter URL is a link in Read mode and has an open link in Write mode', async ({ page, api, vault }) => {
  await api.write(vault.id, 'Film.md', NOTE);
  await openApp(page, vault.id);
  await openNote(page, 'Film.md');

  await page.getByTestId('mode-read').click();
  const link = page.getByTestId('read-view').locator('.prop a[href^="https://example.com"]');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByTestId('read-view').locator('.prop a')).toHaveCount(1); // not the plain-text value

  await page.getByTestId('mode-write').click();
  const row = page.locator('[data-testid="props-row"][data-key="trailer"]');
  const open = row.getByTestId('props-open');
  await expect(open).toHaveAttribute('href', 'https://example.com/watch?v=abc');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(page.locator('[data-testid="props-row"][data-key="note"]').getByTestId('props-open')).toHaveCount(0);

  // The input stays editable; the link follows the new value.
  const input = row.getByLabel('trailer');
  await input.fill('https://example.org/x');
  await input.press('Enter');
  await expect(open).toHaveAttribute('href', 'https://example.org/x');
  await input.fill('not a url');
  await input.press('Enter');
  await expect(row.getByTestId('props-open')).toHaveCount(0);
});
