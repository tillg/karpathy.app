import { expect, openApp, test } from './helpers';

// #138: ranked search with stemming and umlaut folding; the matched word is marked even when it isn't the query text.
test('@iphone searching "handtuch" finds and marks "Handtücher", best match first', async ({ page, api, vault }) => {
  await api.write(vault.id, 'Haushalt/Einkauf.md', '# Einkauf\n\nFür das Bad brauchen wir neue Handtücher, die alten sind dünn geworden.\n');
  await api.write(vault.id, 'Haushalt/Handtuch.md', '# Handtuch\n\nEin Handtuch ist ein Tuch zum Abtrocknen.\n');
  await openApp(page, vault.id);
  if (await page.getByTestId('tab-search').isVisible()) await page.getByTestId('tab-search').click();
  else await page.getByTestId('section-search').click();
  await page.getByTestId('search-input').fill('handtuch');
  const results = page.getByTestId('search-result');
  // The note named after the word comes first (#99), then the one that only mentions it.
  await expect(results).toHaveCount(2);
  await expect(results.nth(0)).toHaveAttribute('data-path', 'Haushalt/Handtuch.md');
  const row = page.locator('[data-testid="search-result"][data-path="Haushalt/Einkauf.md"]').locator('..').locator('.sn').first();
  await expect(row.locator('mark')).toHaveText('Handtücher');
  await page.locator('.search').screenshot({ path: `tmp/smart-search/138-${test.info().project.name}.png` });
  await row.click();
  await expect(page.locator('.note-title')).toHaveText('Einkauf');
});
