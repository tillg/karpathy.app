// Takes the website screenshots site/screenshots/{mac,ipad,iphone}.webp from a running stack with the demo vault
// (specs/changes/website-screenshots-and-origin). Defaults: this checkout's `just prodtest`, vault `demo-wiki`.
//   node site/capture.mjs [--url https://localhost:8015] [--token-file tmp/prodtest/secrets/bearer_token]
//                         [--vault demo-wiki] [--note Wiki/synthesis/which-brewer-for-which-bean.md] [--ask "question"]
// --ask first starts a chat with that question (on the Mac) and waits for the answer; without it the shots show
// the vault's newest chat. Needs `cwebp` (brew install webp).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { webkit } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({
  options: {
    url: { type: 'string', default: `https://localhost:${readFileSync(join(root, 'tmp/prodtest/stack'), 'utf8').trim() * 10 + 8005}` },
    'token-file': { type: 'string', default: join(root, 'tmp/prodtest/secrets/bearer_token') },
    vault: { type: 'string', default: 'demo-wiki' },
    note: { type: 'string', default: 'Wiki/synthesis/which-brewer-for-which-bean.md' },
    ask: { type: 'string' },
  },
});
const token = readFileSync(opt['token-file'], 'utf8').trim();
const TURN = 300_000;

// The device classes of the domain table: viewport in CSS px and pixel ratio.
const devices = {
  mac: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  ipad: { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const tree = (page, path) => page.locator(`[data-testid="tree-item"][data-path="${path}"]`);

async function openNote(page, path) {
  if ((await page.locator('#sidebar').getAttribute('inert')) !== null) await page.getByTestId('sidebar-toggle').click();
  const parts = path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dir = tree(page, parts.slice(0, i).join('/'));
    if ((await dir.getAttribute('aria-expanded')) === 'false') await dir.click();
  }
  await tree(page, path).click();
  await page.locator('.note-title').waitFor();
  // Read mode: the rendered page (pictures, tables), not the editor and its properties form.
  const read = page.getByRole('button', { name: 'Read', exact: true });
  if (await read.isVisible()) await read.click();
}

async function ask(page, question) {
  await page.getByTestId('new-chat').click();
  await page.getByTestId('chat-composer').fill(question);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-stop').waitFor();
  await page.getByTestId('chat-send').waitFor({ timeout: TURN });
}

async function shoot(browser, name) {
  const ctx = await browser.newContext({ ...devices[name], ignoreHTTPSErrors: true, colorScheme: 'light', baseURL: opt.url });
  await ctx.addInitScript(([t, v]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('karpathy.token', t);
    localStorage.setItem('karpathy.activeVault', v);
    localStorage.setItem('karpathy.pageMode', 'read');
  }, [token, opt.vault]);
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('vault-switcher').first().waitFor();
  if (name === 'iphone') {
    await page.getByTestId('tab-chat').click();
  } else {
    await openNote(page, opt.note);
    if (!(await page.locator('#chat').isVisible())) await page.getByTestId('chat-toggle').click();
    if (await page.getByTestId('chat-back').isVisible()) await page.getByTestId('chat-back').click();
  }
  if (name === 'mac' && opt.ask) await ask(page, opt.ask);
  else await page.getByTestId('chat-item').first().click();
  await page.getByTestId('chat-messages').waitFor();
  // Start of the conversation: the question and the files the AI read come first.
  await page.waitForTimeout(1000);
  await page.locator('#chat').evaluate((chat) => {
    for (const el of [chat, ...chat.querySelectorAll('*')]) if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
  });
  await page.waitForTimeout(500);
  await page.waitForTimeout(2500);
  const png = join(root, 'tmp/website-shots', `${name}.png`);
  await page.screenshot({ path: png });
  execFileSync('cwebp', ['-quiet', '-q', '82', png, '-o', join(root, 'site/screenshots', `${name}.webp`)]);
  console.log(`site/screenshots/${name}.webp`);
  await ctx.close();
}

mkdirSync(join(root, 'tmp/website-shots'), { recursive: true });
const browser = await webkit.launch();
try {
  for (const name of Object.keys(devices)) await shoot(browser, name);
} finally {
  await browser.close();
}
