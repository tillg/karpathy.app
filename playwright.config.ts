import { defineConfig, devices } from '@playwright/test';
import { stackTarget } from './e2e/stack';

// E2E against this checkout's dev stack (`just dev up`, https://localhost:80N0, self-signed).
// E2E_BASE_URL / E2E_TOKEN_FILE point it at another stack (deploy/compose.prodtest.yml).
// Every test creates its own throwaway vault from a local bare repo under tmp/dev/remotes/e2e/.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'tmp/test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'tmp/playwright-report', open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: stackTarget(process.env, import.meta.dirname).baseURL,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    browserName: 'chromium',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, grepInvert: /@ipad|@iphone/ },
    { name: 'ipad', use: { browserName: 'chromium', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true }, grep: /@ipad/ },
    { name: 'iphone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, grep: /@iphone/ },
    // Safari engine (the MVP targets iPad/iPhone Safari). Same test selection as the Chromium projects.
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], browserName: 'webkit', viewport: { width: 1280, height: 800 } }, grepInvert: /@ipad|@iphone/ },
    { name: 'webkit-ipad', use: { ...devices['iPad (gen 7)'], browserName: 'webkit', viewport: { width: 820, height: 1180 } }, grep: /@ipad/ },
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'], browserName: 'webkit' }, grep: /@iphone/ },
  ],
});
