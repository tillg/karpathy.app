import { expect, openApp, openNote, test } from './helpers';

// #92: the local graph of the open note, opened from the note's outline, at depth 1 or 2.
test('92 local graph shows the open note with its links and backlinks, depth 1 or 2, and opens a note', async ({ page, api, vault }) => {
  await api.write(vault.id, 'wiki/L0.md', '---\ntype: entity\n---\n# L0\n\nSee [[L1]].\n');
  await api.write(vault.id, 'wiki/L1.md', '---\ntype: concept\n---\n# L1\n\nSee [[L3]].\n');
  await api.write(vault.id, 'wiki/L2.md', '---\ntype: source\n---\n# L2\n\nAbout [[L0]].\n');
  await api.write(vault.id, 'wiki/L3.md', '---\ntype: synthesis\n---\n# L3\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/L0.md');

  await page.getByTestId('outline-button').click();
  await page.getByTestId('local-graph').click();
  const pane = page.getByTestId('graph-pane');
  const graph = pane.getByTestId('graph');
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('graph-local')).toHaveAttribute('aria-pressed', 'true');
  // Depth 1: L0, its link L1 and its backlink L2.
  await expect(graph).toHaveAttribute('data-nodes', '3');
  await expect(graph).toHaveAttribute('data-links', '2');
  await expect(graph.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('graph-legend')).toContainText('source');
  await expect(page.getByTestId('graph-legend')).not.toContainText('synthesis');

  await page.getByTestId('graph-depth-2').click();
  await expect(graph).toHaveAttribute('data-nodes', '4');
  await expect(graph).toHaveAttribute('data-links', '3');
  await expect(page.getByTestId('graph-legend')).toContainText('synthesis');

  // The vault-wide views are one tap away; back to the note's graph keeps the depth.
  await page.getByTestId('graph-wiki').click();
  await expect(page.getByTestId('graph-depth-2')).toBeHidden();
  await page.getByTestId('graph-local').click();
  await expect(graph).toHaveAttribute('data-nodes', '4');

  // A note in the graph opens; the graph closes, and reopening it shows the new note's neighbourhood.
  // The canvas dots and the screen-reader list of the same notes call the same openNote.
  await page.getByTestId('graph-note').filter({ hasText: 'L3' }).focus();
  await page.keyboard.press('Enter');
  await expect(pane).toBeHidden();
  await expect(page.locator('.note-title')).toHaveText('L3');
  await page.getByTestId('open-graph').click();
  await expect(page.getByTestId('graph-local')).toHaveAttribute('aria-pressed', 'true');
  await expect(graph).toHaveAttribute('data-nodes', '3'); // L3, L1, L0
});

test('@iphone 92 the local graph opens from the outline sheet and goes back to the note', async ({ page, api, vault }) => {
  await api.write(vault.id, 'wiki/P0.md', '# P0\n\nSee [[P1]].\n');
  await api.write(vault.id, 'wiki/P1.md', '# P1\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/P0.md');
  await page.getByTestId('outline-button').click();
  await page.getByTestId('local-graph').click();
  await expect(page.getByTestId('outline')).toBeHidden();
  await expect(page.getByTestId('graph')).toHaveAttribute('data-nodes', '2');
  await page.getByTestId('graph-close').click();
  await expect(page.getByTestId('graph-pane')).toBeHidden();
  await expect(page.locator('.note-title')).toHaveText('P0');
});
