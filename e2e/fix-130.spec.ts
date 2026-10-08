import { expect, openApp, openNote, test, TOKEN } from './helpers';

// #130: a 3D graph of the vault's notes and their links, opened from the sidebar into the note pane.
test('130 graph shows the Wiki notes in the note pane, all on request, and is read once', async ({ page, api, vault }) => {
  await api.write(vault.id, 'wiki/G1.md', '---\ntype: entity\n---\n# G1\n\nSee [[G2]] and [[Outside]].\n');
  await api.write(vault.id, 'wiki/G2.md', '---\ntype: concept\n---\n# G2\n');
  await api.write(vault.id, 'Outside.md', '# Outside\n');
  const want = await (await page.request.get(`/api/vaults/${vault.id}/graph`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  expect(want.links).toContainEqual({ source: 'wiki/G1.md', target: 'wiki/G2.md' });
  const wiki = want.nodes.filter((n: { path: string }) => /^wiki\//i.test(n.path));
  const wikiLinks = want.links.filter((l: { source: string; target: string }) => /^wiki\//i.test(l.source) && /^wiki\//i.test(l.target));
  let reads = 0;
  page.on('request', (r) => { if (r.url().endsWith('/graph')) reads++; });
  await openApp(page, vault.id);

  await page.getByTestId('open-graph').click();
  const graph = page.locator('#detail').getByTestId('graph');
  await expect(graph).toHaveAttribute('data-nodes', String(wiki.length));
  await expect(graph).toHaveAttribute('data-links', String(wikiLinks.length));
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('graph-legend')).toContainText('concept');

  await page.getByTestId('graph-all').click();
  await expect(graph).toHaveAttribute('data-nodes', String(want.nodes.length));
  await expect(graph).toHaveAttribute('data-links', String(want.links.length));

  // A type switched off in the legend is hidden, and stays off after a reload.
  await page.getByTestId('graph-type-concept').uncheck();
  await expect(graph).toHaveAttribute('data-nodes', String(want.nodes.filter((n: { type?: string }) => n.type !== 'concept').length));
  await page.reload();
  await page.getByTestId('open-graph').click();
  await expect(page.getByTestId('graph-type-concept')).not.toBeChecked();
  await expect(page.getByTestId('graph-type-entity')).toBeChecked();
  await page.getByTestId('graph-type-concept').check();
  await expect(graph).toHaveAttribute('data-nodes', String(wiki.length));

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('graph-pane')).toBeHidden();
  await page.getByTestId('open-graph').click();
  await expect(graph.locator('canvas')).toBeVisible();
  expect(reads).toBe(2); // once before and once after the reload
  await page.getByTestId('graph-refresh').click();
  await expect.poll(() => reads).toBe(3);
  await page.getByTestId('graph-close').click();
  await expect(page.getByTestId('graph-pane')).toBeHidden();
});

test('@iphone 130 the graph is pushed like a note; closing it returns to the tab it was opened from', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const app = page.locator('#app');
  await page.getByTestId('open-graph').click();
  await expect(app).toHaveAttribute('data-dt', 'cur');
  await expect(page.getByTestId('graph-pane')).toBeVisible();
  await page.getByTestId('graph-close').click();
  await expect(app).not.toHaveAttribute('data-dt', 'cur');
  await expect(page.getByTestId('graph-pane')).toBeHidden();

  await openNote(page, 'Home.md');
  await page.getByTestId('back').click();
  await page.getByTestId('open-graph').click();
  await expect(app).toHaveAttribute('data-dt', 'cur');
  await page.getByTestId('graph-close').click();
  await expect(app).not.toHaveAttribute('data-dt', 'cur');
  // Opening a note (here by route; a tap on a dot calls the same openNote) shows it in place of the graph.
  await page.getByTestId('open-graph').click();
  await page.evaluate((id) => { location.hash = `#/${encodeURIComponent(id)}/Ideas.md`; }, vault.id);
  await expect(page.locator('.note-title')).toHaveText('Ideas');
  await expect(page.getByTestId('graph-pane')).toBeHidden();
  await expect(app).toHaveAttribute('data-dt', 'cur');
});
