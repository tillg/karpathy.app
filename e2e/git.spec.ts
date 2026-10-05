import { breakRemote, expect, openApp, openNote, openSettings, pushFromObsidian, remoteLog, remoteShow, test, treeItem, typeAtEnd, waitSaved } from './helpers';
import type { Page } from '@playwright/test';

const changeItem = (page: Page, path: string) => page.locator(`[data-testid="change-item"][data-path="${path}"]`);

/** Opens the commit dialog and waits for the (AI-proposed or fallback) message. */
async function openCommitDialog(page: Page) {
  await page.getByTestId('section-changes').click();
  await page.getByTestId('commit-button').click();
  await expect(page.getByTestId('commit-dialog')).toBeVisible();
  // The proposal runs through the (slow) model and falls back to "Update N files" after 15 s.
  await expect(page.getByTestId('commit-message')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('commit-message')).not.toHaveValue('');
}

async function commitAll(page: Page, message: string) {
  await openCommitDialog(page);
  await page.getByTestId('commit-message').fill(message);
  await page.getByTestId('commit-submit').click();
}

const headSubject = (bare: string) => remoteLog(bare)[0];

test.describe('changes, commit & push', () => {
  test('Show changes lists the diff; Discard restores the file', async ({ page, api, vault }) => {
    page.on('dialog', (d) => void d.accept());
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nBack to [[Home]].\nAdded by e2e.\n');
    await api.write(vault.id, 'Brand new.md', '# Brand new\n');
    await openApp(page, vault.id);
    await page.getByTestId('section-changes').click();
    await expect(page.locator('.commit-bar')).toContainText('2 changes');
    await expect(changeItem(page, 'Ideas.md').locator('.kind')).toHaveText('M');
    await expect(changeItem(page, 'Brand new.md').locator('.kind')).toHaveText(/U|A/);

    await changeItem(page, 'Ideas.md').locator('.chg-main').click();
    const diff = changeItem(page, 'Ideas.md').getByTestId('diff');
    await expect(diff.locator('.dl.ad')).toHaveText(['+Added by e2e.']);
    await page.screenshot({ path: test.info().outputPath('changes-diff.png') });

    await changeItem(page, 'Ideas.md').getByTestId('discard').click();
    await expect(changeItem(page, 'Ideas.md')).toHaveCount(0);
    await expect(page.getByTestId('changes-badge')).toHaveAttribute('data-count', '1');
    expect((await api.file(vault.id, 'Ideas.md'))?.content).toBe('# Ideas\n\nBack to [[Home]].\n');
  });

  test('Commit & Push: message prefilled + editable, commit lands in the remote, tree clean', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    await typeAtEnd(page, '\nCommitted from e2e.');
    await waitSaved(page);
    await openCommitDialog(page);
    const proposed = await page.getByTestId('commit-message').inputValue();
    expect(proposed.trim().length).toBeGreaterThan(0);
    await page.getByTestId('commit-message').fill('e2e: my own commit message');
    await page.getByTestId('commit-submit').click();
    await expect(page.getByTestId('toast')).toContainText('Committed and pushed to GitHub');
    await expect(page.getByTestId('commit-dialog')).toBeHidden();
    await expect(page.getByTestId('changes-badge')).toHaveAttribute('data-count', '0');
    expect(headSubject(vault.bare)).toBe('e2e: my own commit message');
    expect(remoteShow(vault.bare, 'Ideas.md')).toContain('Committed from e2e.');
    expect(await api.changes(vault.id)).toEqual([]);
    // Author = the user (dev: GIT_AUTHOR_NAME), no AI trailer for a human-only change.
    expect(remoteLog(vault.bare, '%an')[0]).not.toBe('seed');
    expect(remoteLog(vault.bare, '%b')[0]).not.toContain('Co-authored-by');
  });

  test('commit within the 1.5 s autosave debounce includes the typed text', async ({ page, api, vault }) => {
    // A saved change so the Commit button is enabled while the note is still unsaved.
    await api.write(vault.id, 'Other.md', '# Other\n');
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    await page.getByTestId('section-changes').click();
    await expect(page.getByTestId('commit-button')).toBeEnabled();
    await typeAtEnd(page, '\nTyped right before commit.');
    await page.getByTestId('commit-button').click(); // well within 1.5 s of the last keystroke
    await expect(page.getByTestId('commit-message')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('commit-message').fill('e2e: debounce commit');
    await page.getByTestId('commit-submit').click();
    await expect(page.getByTestId('toast')).toContainText('Committed and pushed');
    expect(headSubject(vault.bare)).toBe('e2e: debounce commit');
    expect(remoteShow(vault.bare, 'Ideas.md')).toContain('Typed right before commit.');
    expect(remoteShow(vault.bare, 'Other.md')).toBe('# Other');
    expect(await api.changes(vault.id)).toEqual([]);
  });

  test('commit reminder above the threshold offers Commit', async ({ page, api, vault }) => {
    // The threshold is a global setting: set it via the admin UI, restore it afterwards.
    const before = (await api.settings()).commitReminderThreshold;
    try {
      await openApp(page, vault.id);
      await openSettings(page);
      await page.getByTestId('settings-threshold').fill('2');
      await page.getByTestId('settings-save').click();
      await expect(page.getByTestId('toast')).toContainText('Settings saved');
      await page.getByTestId('settings-dialog').getByRole('button', { name: 'Close', exact: true }).click();

      await api.write(vault.id, 'R1.md', '# R1\n');
      await api.write(vault.id, 'R2.md', '# R2\n');
      await expect(page.getByTestId('changes-badge')).toHaveAttribute('data-count', '2');
      await expect(page.getByTestId('reminder-dialog')).toBeHidden();
      await api.write(vault.id, 'R3.md', '# R3\n');
      const reminder = page.getByTestId('reminder-dialog');
      await expect(reminder).toBeVisible();
      await expect(reminder).toContainText('3 uncommitted changes');
      // Dismiss → stays away until 2× threshold.
      await reminder.getByRole('button', { name: 'Later' }).click();
      await expect(reminder).toBeHidden();
      await api.write(vault.id, 'R4.md', '# R4\n');
      await expect(page.getByTestId('changes-badge')).toHaveAttribute('data-count', '4');
      await expect(reminder).toBeVisible();
      await page.getByTestId('reminder-commit').click();
      await expect(page.getByTestId('commit-dialog')).toBeVisible();
    } finally {
      await api.patchSettings({ commitReminderThreshold: before });
    }
  });

  test('push failure → unpushed commit + retry pushes it', async ({ page, api, vault }) => {
    await api.write(vault.id, 'Ideas.md', '# Ideas\n\nunpushed\n');
    await openApp(page, vault.id);
    const restore = breakRemote(vault.bare);
    let restored = false;
    try {
      await commitAll(page, 'e2e: pushed later');
      await expect(page.getByTestId('toast')).toContainText('push failed');
      await expect(page.getByTestId('unpushed')).toContainText('1 unpushed commit');
      await expect(page.getByTestId('changes-badge')).toContainText('1 unpushed');
      restore();
      restored = true;
      expect(headSubject(vault.bare)).not.toBe('e2e: pushed later');
      await page.getByTestId('unpushed').getByRole('button', { name: 'retry' }).click();
      await expect(page.getByTestId('toast')).toContainText('Pushed to GitHub');
      await expect(page.getByTestId('unpushed')).toBeHidden();
      expect(headSubject(vault.bare)).toBe('e2e: pushed later');
    } finally {
      if (!restored) restore();
    }
  });

  test('conflict with a change pushed from Obsidian → banner, read-only editor, keep both', async ({ page, api, vault }) => {
    await openApp(page, vault.id);
    await openNote(page, 'Ideas.md');
    // Mine: first line changed locally (uncommitted).
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await waitSaved(page);
    expect((await api.file(vault.id, 'Ideas.md'))?.content).toMatch(/^# Ideas mine\n/);
    // Theirs: Obsidian pushes a clashing edit of the same line.
    pushFromObsidian(vault.bare, 'Ideas.md', '# Ideas theirs\n\nBack to [[Home]].\n');

    await openCommitDialog(page);
    await page.getByTestId('commit-submit').click();
    await expect(page.getByTestId('commit-dialog').getByRole('alert')).toContainText('conflict');
    await page.getByTestId('commit-dialog').getByRole('button', { name: 'Close', exact: true }).click();

    await expect(page.getByTestId('conflict-banner')).toBeVisible();
    await expect(page.getByTestId('changes-badge')).toHaveText(/Conflict/);
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await expect(page.getByTestId('save-state')).toContainText('read-only');
    await expect(page.getByTestId('commit-button')).toBeDisabled();
    const item = page.locator('[data-testid="conflict-item"][data-path="Ideas.md"]');
    await expect(item).toContainText('# Ideas mine');
    await expect(item).toContainText('# Ideas theirs');
    expect((await api.status(vault.id)).state).toBe('conflict');
    await page.screenshot({ path: test.info().outputPath('conflict.png') });

    await item.getByTestId('keep-both').click();
    await item.getByTestId('resolve').click();
    await expect(page.getByTestId('conflict-banner')).toBeHidden();
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
    const files = (await api.files(vault.id)).map((f) => f.path);
    const copy = files.find((p) => /^Ideas\.conflict-.+\.md$/.test(p));
    expect(copy, files.join(', ')).toBeTruthy();
    expect((await api.file(vault.id, 'Ideas.md'))?.content).toMatch(/^# Ideas mine\n/);
    expect((await api.file(vault.id, copy!))?.content).toMatch(/^# Ideas theirs\n/);
    await page.getByTestId('section-files').click();
    await expect(treeItem(page, copy!)).toBeVisible();
    expect((await api.status(vault.id)).state).toBe('ready');
  });
});
