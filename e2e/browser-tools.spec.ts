import type { Page } from '@playwright/test';
import { backendExec, expect, openApp, PROJECT, test } from './helpers';

// Time and place from the browser (spec change browser-tools, #151). The first test is deterministic: every prompt
// carries the tab's time zone, and the backend hands the model a hidden local-time line. The others use the real model
// (dev: OpenRouter) and the browser's real Geolocation API, faked by Playwright: assertions on chips and tool output.
const TURN = 8 * 60_000;
test.describe.configure({ timeout: 25 * 60_000 });

const turnOver = (page: Page) => expect(page.getByTestId('chat-send')).toBeAttached({ timeout: TURN });

/** Opens the chat (the Chat tab on a phone, the pane elsewhere) and starts a new chat. */
async function newChat(page: Page) {
  if (await page.getByTestId('tab-chat').isVisible()) await page.getByTestId('tab-chat').click();
  else if ((await page.locator('#chat').getAttribute('inert')) !== null) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('new-chat').click();
}

async function send(page: Page, text: string) {
  await page.getByTestId('chat-composer').fill(text);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-stop')).toBeAttached();
}

/** The parts opencode stored for a vault's chats, read inside the backend container (it has opencode's password). */
function storedParts(vaultId: string): { type: string; text?: string; synthetic?: boolean; tool?: string; state?: { output?: string } }[] {
  const script = `
    const v = process.argv[1];
    const auth = { Authorization: 'Basic ' + Buffer.from('opencode:' + require('fs').readFileSync('/run/secrets/opencode_password', 'utf8').trim()).toString('base64') };
    const q = '?directory=' + encodeURIComponent('/vaults/' + v);
    (async () => {
      const sessions = await (await fetch('http://opencode:4096/session' + q, { headers: auth })).json();
      const out = [];
      for (const s of sessions) for (const m of await (await fetch('http://opencode:4096/session/' + s.id + '/message' + q, { headers: auth })).json()) out.push(...m.parts);
      console.log(JSON.stringify(out));
    })();`;
  return JSON.parse(backendExec('node', '-e', script, vaultId));
}

const localTimeLines = (vaultId: string) => storedParts(vaultId).filter((p) => p.type === 'text' && p.synthetic && p.text?.startsWith("User's local time:")).map((p) => p.text!);
const locationOutputs = (vaultId: string) => storedParts(vaultId).filter((p) => p.tool === 'user_location').map((p) => p.state?.output ?? '');

test.describe('local time', () => {
  test.use({ timezoneId: 'Pacific/Auckland', locale: 'en-NZ' });

  test('a prompt carries the tab time zone; the model gets a hidden local-time line, the chat does not show it', async ({ page, vault }) => {
    await openApp(page, vault.id);
    await newChat(page);
    await send(page, 'what day is it?');
    await expect.poll(() => localTimeLines(vault.id), { timeout: 30_000 }).toEqual([expect.stringMatching(/, Pacific\/Auckland \(UTC\+1[23]:00\), locale en-NZ\./)]);
    await expect(page.getByText("User's local time")).toHaveCount(0);
    // The user's own words stay in their bubble (the stored chat: chat.test "local time").
    await expect(page.locator('#chat .u').last()).toHaveText('what day is it?');
    await page.locator('#chat').screenshot({ path: 'tmp/browser-tools/local-time.png' });
  });
});

const PROMPTS = ['Call the user_location tool to get my position. Do nothing else.', 'Call the user_location tool now.'];

/** Sends the prompts until the model calls user_location (the small dev model sometimes answers without). */
async function askLocation(page: Page) {
  await newChat(page);
  const chip = page.locator('[data-testid="tool-chip"]', { hasText: /location/ });
  for (const prompt of PROMPTS) {
    await send(page, prompt);
    await turnOver(page);
    if (await chip.count()) break;
  }
  return chip;
}

test.describe('user_location, permission granted', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 48.137154, longitude: 11.576124, accuracy: 12 } });

  for (const tag of ['', ' @iphone']) {
    test(`@llm the model gets the exact position; the chip shows the accuracy${tag}`, async ({ page, vault }) => {
      await openApp(page, vault.id);
      const chip = await askLocation(page);
      await page.screenshot({ path: `tmp/browser-tools/location${tag.trim() || '-desktop'}.png` });
      await expect(chip.first()).toContainText('used your location (±12 m)');
      expect(locationOutputs(vault.id)).toContainEqual(expect.stringMatching(/^The user is at 48\.137154, 11\.576124 \(accuracy ±12 m, fix \d+ s old\)\.$/));
    });
  }
});

test.describe('user_location, permission denied', () => {
  test.use({ permissions: [] });

  test('@llm declining is an ordinary answer: the chip says not shared', async ({ page, vault, browserName }) => {
    test.skip(browserName !== 'chromium', 'headless Chromium denies an ungranted permission; WebKit would wait for a prompt');
    await openApp(page, vault.id);
    const chip = await askLocation(page);
    await expect(chip.first()).toContainText('location not shared');
    expect(locationOutputs(vault.id)).toContain('The user did not share their location.');
  });
});

test('the proxy keeps geolocation to the app itself: Permissions-Policy geolocation=(self)', async ({ page }) => {
  test.skip(PROJECT !== undefined, 'the dev proxy sends no security headers: runs against the prod images (just prodtest)');
  const res = await page.request.get('/');
  expect(res.headers()['permissions-policy']).toBe('geolocation=(self)');
});
