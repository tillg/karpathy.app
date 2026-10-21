import { randomBytes } from 'node:crypto';
import { expect, openApp, remoteLog, test } from './helpers';

/** A fake GitHub token built at runtime, so the repo's own secret scan finds none in this file. */
function fakeToken(): string {
  let s = '';
  while (s.length < 36) s += randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return ['gh', 'p_'].join('') + s.slice(0, 36);
}

// #141: a possible secret in the changes blocks Commit & Push with file, line and rule (masked), until the user
// removes it or deliberately commits anyway.
test('a secret in the changes blocks the commit; "Commit anyway" commits it deliberately', async ({ page, api, vault }) => {
  const token = fakeToken();
  await api.write(vault.id, 'Mail.md', `# Mail\n\nAccess: ${token}\n`);
  await openApp(page, vault.id);
  await page.getByTestId('changes-badge').first().click();
  await page.getByTestId('commit-button').click();
  const msg = page.getByTestId('commit-message');
  await expect(msg).toBeEnabled({ timeout: 30_000 });
  await msg.fill('Add mail');
  await page.getByTestId('commit-submit').click();

  const alert = page.getByTestId('commit-secrets');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText('Mail.md');
  await expect(alert).toContainText('line 3');
  await expect(alert).toContainText('github-pat');
  await expect(page.getByTestId('commit-dialog')).not.toContainText(token.slice(4));
  expect(remoteLog(vault.bare)).not.toContain('Add mail');

  await page.getByTestId('commit-anyway').click();
  await expect(page.getByTestId('commit-dialog')).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => remoteLog(vault.bare)[0]).toBe('Add mail');
});
