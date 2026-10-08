import { expect, openSettings, openApp, PROJECT, test } from './helpers';

// Admin › Instagram against the dev stack's ingest service, which runs a fake Instagram login there
// (INGEST_FAKE_INSTAGRAM_LOGIN, compose.dev.yml): password `wrong` fails, user twofa… asks for code 000000 by SMS.
// One Instagram session per stack: only the desktop project runs this, and it ends disconnected.

test.beforeEach(({}, info) => {
  // Only a dev stack has the fake login; anywhere else this would be a real login attempt at Instagram.
  test.skip(!PROJECT, 'needs a dev stack (fake Instagram login)');
  test.skip(info.project.name !== 'desktop', 'one shared Instagram session per stack');
});

test('Admin › Instagram: wrong password, then connect with a code, then disconnect', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await openSettings(page);
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog.getByTestId('ig-status')).toHaveText(/Not connected/);

  await dialog.getByTestId('ig-username').fill('twofa_e2e');
  await dialog.getByTestId('ig-password').fill('wrong');
  await dialog.getByTestId('ig-connect').click();
  await expect(dialog.getByTestId('ig-error')).toHaveText(/Wrong username or password/);
  await expect(dialog.getByTestId('ig-password')).toHaveValue('');

  await dialog.getByTestId('ig-password').fill('pw');
  await dialog.getByTestId('ig-connect').click();
  await expect(dialog.getByTestId('ig-code-hint')).toHaveText('Code sent by SMS');
  await dialog.getByTestId('ig-code').fill('000000');
  await dialog.getByTestId('ig-verify').click();
  await expect(dialog.getByTestId('ig-status')).toHaveText(/Connected as @twofa_e2e/);

  await dialog.getByTestId('ig-disconnect').click();
  await expect(dialog.getByTestId('ig-status')).toHaveText(/Not connected/);
});
