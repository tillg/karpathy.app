import type { Page } from '@playwright/test';
import { expect, openApp, openNote, pushFromObsidian, revealInTree, test, treeItem, type TestVault } from './helpers';

// Wiki dashboards (#91): a fenced ```base block (Obsidian Bases syntax) renders a live, read-only table.

const DASHBOARD = `# Maintenance

## Low-confidence entities

\`\`\`base
filters:
  and:
    - file.inFolder("Wiki/entities")
    - 'confidence == "low"'
properties:
  confidence:
    displayName: Confidence
views:
  - type: table
    name: Low confidence
    order:
      - file.basename
      - confidence
      - updated
    sort:
      - property: updated
        direction: DESC
\`\`\`

Text after the table.
`;

const entity = (confidence: string, updated: string) => `---\nconfidence: ${confidence}\nupdated: ${updated}\n---\n# Entity\n`;

function seed(vault: TestVault) {
  pushFromObsidian(vault.bare, 'Wiki/entities/eureka-labs.md', entity('low', '2026-06-02'));
  pushFromObsidian(vault.bare, 'Wiki/entities/tinygrad.md', entity('low', '2026-07-19'));
  pushFromObsidian(vault.bare, 'Wiki/entities/micrograd.md', entity('high', '2026-09-01'));
  pushFromObsidian(vault.bare, 'Dashboards/maintenance.md', DASHBOARD);
}

const rows = (page: Page, scope: string) => page.locator(`${scope} [data-testid="base-view"] tbody tr`);

test('a base block is a table in Write and Read mode; a row opens its note; it re-runs when a note changes', async ({ page, api, vault }) => {
  seed(vault);
  await openApp(page, vault.id);
  await openNote(page, 'Dashboards/maintenance.md');

  // Write: the live preview shows the table in place of the block; the text stays in the file.
  await expect(rows(page, '.cm-content')).toHaveCount(2);
  await expect(page.locator('.cm-content [data-testid="base-view"] th')).toHaveText(['file basename', 'Confidence', 'updated']);
  await expect(rows(page, '.cm-content').first()).toContainText('tinygrad');
  await expect(page.locator('.cm-content')).not.toContainText('file.inFolder');
  await expect(page.locator('.cm-content')).toContainText('Text after the table.');
  await page.screenshot({ path: test.info().outputPath('base-write.png') });
  // Edit shows the source again.
  await page.locator('.cm-content [data-testid="base-edit"]').click();
  await expect(page.locator('.cm-content')).toContainText('file.inFolder("Wiki/entities")');
  expect((await api.file(vault.id, 'Dashboards/maintenance.md'))!.content).toBe(DASHBOARD);

  // Read.
  await page.getByTestId('mode-read').click();
  await expect(rows(page, '.read')).toHaveCount(2);
  await expect(page.locator('.read [data-testid="base-view"] .base-foot')).toHaveText('2 rows');

  // Live: a note changed by the AI or another device joins the table without a reload.
  await api.write(vault.id, 'Wiki/entities/micrograd.md', entity('low', '2026-09-01'));
  await expect(rows(page, '.read')).toHaveCount(3);
  await expect(rows(page, '.read').first()).toContainText('micrograd');

  // A tap on a row opens the note.
  await rows(page, '.read').nth(1).click();
  await expect(page.locator('.note-title')).toHaveText('tinygrad');
});

test('syntax v1 does not know shows a clear inline message, the rest of the note renders', async ({ page, vault }) => {
  pushFromObsidian(vault.bare, 'Dash.md', '# Dash\n\n```base\nviews:\n  - type: cards\n    name: Gallery\n```\n\nStill here.\n');
  await openApp(page, vault.id);
  await openNote(page, 'Dash.md');
  await page.getByTestId('mode-read').click();
  await expect(page.locator('.read [data-testid="base-error"]')).toContainText('not supported in v1');
  await expect(page.locator('.read')).toContainText('Still here.');
});

test('a .base file shows its table in Read mode and its YAML in Write mode', async ({ page, vault }) => {
  seed(vault);
  pushFromObsidian(vault.bare, 'Dashboards/entities.base', 'filters: file.inFolder("Wiki/entities")\nviews:\n  - type: table\n    order: [file.name, confidence]\n');
  await openApp(page, vault.id);
  await revealInTree(page, 'Dashboards/entities.base');
  await treeItem(page, 'Dashboards/entities.base').click();
  await page.getByTestId('mode-read').click();
  await expect(page.locator('[data-testid="base-file"] tbody tr')).toHaveCount(3);
  await page.getByTestId('mode-write').click();
  await expect(page.locator('.cm-content')).toContainText('file.inFolder("Wiki/entities")');
});

test('@iphone a wide table scrolls sideways inside its box, never the page', async ({ page, vault }) => {
  const wide = Array.from({ length: 8 }, (_, i) => `prop${i}: a-rather-long-value-number-${i}`).join('\n');
  pushFromObsidian(vault.bare, 'Wiki/wide.md', `---\n${wide}\n---\n# Wide\n`);
  pushFromObsidian(vault.bare, 'Wide.md', `# Wide\n\n\`\`\`base\nfilters: file.hasProperty("prop0")\nviews:\n  - type: table\n    order: [file.name, ${Array.from({ length: 8 }, (_, i) => `prop${i}`).join(', ')}]\n\`\`\`\n`);
  await openApp(page, vault.id);
  await treeItem(page, 'Wide.md').click();
  for (const scope of ['.cm-content', '.read']) {
    if (scope === '.read') await page.getByTestId('mode-read').click();
    const scroll = page.locator(`${scope} .base-scroll`);
    await expect(scroll.locator('tbody tr')).toHaveCount(1);
    expect(await scroll.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await scroll.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: test.info().outputPath(`phone-base-${scope === '.read' ? 'read' : 'write'}.png`) });
  }
});
