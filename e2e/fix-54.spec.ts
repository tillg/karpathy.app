import { expect, openApp, test } from './helpers';

// #54: the highlighted match stays visible in narrow result rows.
test('@iphone @ipad a match deep in a long line is visible and highlighted in the result row', async ({ page, api, vault }) => {
  await api.write(vault.id, 'Distillation.md', '---\nrelated: [jarvis, vannevar-bush, zettelkasten, mémoire-de-travail, spaced-repetition, knowledge-compilation]\n---\n# Distillation\n');
  await openApp(page, vault.id);
  if (await page.getByTestId('tab-search').isVisible()) await page.getByTestId('tab-search').click();
  else {
    await page.getByTestId('sidebar-toggle').click(); // iPad: the sidebar is an overlay
    await page.getByTestId('section-search').click();
  }
  await page.getByTestId('search-input').fill('mémoire');
  const row = page.locator('[data-testid="search-result"][data-path="Distillation.md"]').locator('..').locator('.sn').first();
  const mark = row.locator('mark');
  await expect(mark).toHaveText('mémoire');
  const r = (await row.boundingBox())!;
  const m = (await mark.boundingBox())!;
  expect(m.x).toBeGreaterThanOrEqual(r.x);
  expect(m.x + m.width).toBeLessThanOrEqual(r.x + r.width);
  // Centered, not pushed to one edge: context on both sides.
  expect(await row.textContent()).toMatch(/….+mémoire.+/);
  await page.screenshot({ path: `tmp/fix6/54-${test.info().project.name}.png` });
});
