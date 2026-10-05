import { expect, openApp, openSettings, test } from './helpers';

// Dev and prodtest builds report `dev`; a deployed release reports its version (deploy-e2e sets it).
const expected = process.env.E2E_EXPECT_VERSION ?? 'dev';

test('settings dialog shows the server and the PWA version', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  const admin = page.getByTestId('settings-dialog');
  await expect(admin.getByTestId('version-server')).toHaveText(expected);
  await expect(admin.getByTestId('version-pwa')).toHaveText(expected);
  // A release knows when it was built and deployed; local builds have neither.
  if (expected === 'dev') {
    await expect(admin.getByTestId('version-built')).toHaveCount(0);
    await expect(admin.getByTestId('version-deployed')).toHaveCount(0);
  } else {
    await expect(admin.getByTestId('version-built')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(admin.getByTestId('version-deployed')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  }
  await admin.getByTestId('version-server').scrollIntoViewIfNeeded();
  await admin.screenshot({ path: `tmp/e2e/version-${test.info().project.name}.png`, scale: 'css' });
});
