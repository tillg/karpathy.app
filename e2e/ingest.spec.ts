import { backendExec, expect, openApp, pushFromObsidian, test, treeItem, type Api, type TestVault } from './helpers';

// The ingest queue in the file tree (rework-ingestion-pipeline): an item the ingest service writes into Input/ shows
// as a red count on the Input row, and Ingest sends /ingest in a new chat. The deterministic cases assert no model
// behaviour; the @llm case lets the dev model run a stub skill that moves the item.

const SKILL = `---
name: ingest
description: Ingest the sources waiting in Input/
---
Call the tool move_to_sources once with name "mail-2026-10-08-llm". Do nothing else. Then reply "done".
`;

/** The stub ingest skill arrives the way a real one does: pushed to the vault's repo, then pulled. */
async function addSkill(api: Api, vault: TestVault) {
  pushFromObsidian(vault.bare, '.agents/skills/ingest/SKILL.md', SKILL, 'Add the ingest skill');
  const r = await api.ctx.post(`/api/vaults/${vault.id}/pull`);
  expect(r.ok()).toBe(true);
}

/** Writes items into Input/ as the ingest service does: built in a dot-folder, renamed into place. */
function seed(vault: TestVault, items: string[]) {
  const sh = [
    `cd /vaults/${vault.id}`,
    ...items.map((n) => `mkdir -p Input/.tmp-${n} && printf -- '---\\ntitle: ${n}\\n---\\n# ${n}\\n' > Input/.tmp-${n}/index.md && mv Input/.tmp-${n} Input/${n}`),
  ].join(' && ');
  backendExec('sh', '-c', sh);
}

test.beforeEach(async ({ page }) => {
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
});

test('an item written into Input/ shows the badge; Ingest sends /ingest in a new chat', async ({ page, api, vault }) => {
  await addSkill(api, vault);
  await openApp(page, vault.id);
  seed(vault, ['mail-2026-10-08-test']);
  const badge = treeItem(page, 'Input').getByTestId('input-badge');
  await expect(badge).toHaveText('1');
  seed(vault, ['web-2026-10-08-test']);
  await expect(badge).toHaveText('2');

  const ingest = page.getByTestId('ingest-now');
  await expect(ingest).toBeEnabled();
  await ingest.click();
  await expect(page.locator('.msgs .u').first()).toContainText('/ingest');
  // While the turn runs the button is disabled (the dev model may end it first); stop it, the queue stays.
  const stop = page.getByTestId('chat-stop');
  if (await stop.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    await expect(ingest).toBeDisabled();
    await stop.click().catch(() => undefined);
  }
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 30_000 });
});

test('no Ingest button without an ingest skill; the badge says how to add one', async ({ page, vault }) => {
  await openApp(page, vault.id);
  backendExec('sh', '-c', `cd /vaults/${vault.id} && mkdir -p Input/mail-x && printf '# x\\n' > Input/mail-x/index.md`);
  const badge = treeItem(page, 'Input').getByTestId('input-badge');
  await expect(badge).toHaveText('1');
  await expect(badge).toHaveAttribute('title', /Add an `ingest` skill/);
  await expect(page.getByTestId('ingest-now')).toHaveCount(0);
});

test('@llm Ingest moves the item to Sources/: badge gone, the moved file in Changes', async ({ page, api, vault }, info) => {
  // The model's work doesn't depend on the browser engine; one turn at a time keeps the shared dev Ollama responsive.
  test.skip(info.project.name !== 'desktop', 'model behaviour: one browser is enough');
  test.setTimeout(300_000);
  await addSkill(api, vault);
  await openApp(page, vault.id);
  seed(vault, ['mail-2026-10-08-llm']);
  await expect(treeItem(page, 'Input').getByTestId('input-badge')).toHaveText('1');
  await page.getByTestId('ingest-now').click();
  await expect(treeItem(page, 'Input').getByTestId('input-badge')).toHaveCount(0, { timeout: 240_000 });
  expect(backendExec('sh', '-c', `test -f /vaults/${vault.id}/Sources/mail-2026-10-08-llm/index.md && echo yes`).trim()).toBe('yes');
  // Never committed in Input/, so the move shows as the new file in Sources/ only.
  expect((await api.changes(vault.id)).map((c) => c.path)).toContain('Sources/mail-2026-10-08-llm/index.md');
});
