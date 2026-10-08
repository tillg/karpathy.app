import { expect, openApp, test, TOKEN } from './helpers';

// #130: a 3D graph of the vault's notes and their links, opened from the sidebar.
test('130 graph shows the notes and links in a WebGL canvas', async ({ page, api, vault }) => {
  await api.write(vault.id, 'G1.md', '# G1\n\nSee [[G2]].\n');
  await api.write(vault.id, 'G2.md', '# G2\n');
  const want = await (await page.request.get(`/api/vaults/${vault.id}/graph`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  expect(want.links).toContainEqual({ source: 'G1.md', target: 'G2.md' });
  await openApp(page, vault.id);
  await page.getByTestId('open-graph').click();
  const graph = page.getByTestId('graph');
  await expect(graph).toHaveAttribute('data-nodes', String(want.nodes.length));
  await expect(graph).toHaveAttribute('data-links', String(want.links.length));
  await expect(graph.locator('canvas')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('graph-dialog')).toHaveCount(0);
});
