import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendExec, expect, openApp, pushFromObsidian, revealInTree, ROOT, test, treeItem, type TestVault } from './helpers';
import type { Page } from '@playwright/test';

// Media embeds (`![[a.png]]`, `![](path)`) and the media viewer (media-embeds-sticky-mode).
const fixture = (name: string) => readFileSync(join(ROOT, 'e2e/fixtures/media', name));
const push = (v: TestVault, path: string, content: string | Buffer) => pushFromObsidian(v.bare, path, content);

const openInRead = async (page: Page, path: string) => {
  await revealInTree(page, path);
  await treeItem(page, path).click();
  await expect(page.locator('.note-title')).toHaveText(path.split('/').pop()!.replace(/\.md$/, ''));
  if ((await page.getByTestId('mode-read').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('read-view')).toBeVisible();
};

test('embedded image renders in Read mode and is fetched once', async ({ page, api, vault }) => {
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  push(vault, 'Img.md', '# Img\n\n![[dot.png]]\n\nBetween.\n\n![[dot.png]]\n');
  push(vault, 'Fresh.md', '# Fresh\n\n![[ring.svg]]\n');
  const raws: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/raw?')) raws.push(decodeURIComponent(r.url())); });
  await openApp(page, vault.id);
  await openInRead(page, 'Img.md');
  const imgs = page.locator('.read .embed img');
  await expect(imgs).toHaveCount(2);
  for (const i of [0, 1]) await expect.poll(() => imgs.nth(i).evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  expect(raws.filter((u) => u.includes('dot.png'))).toHaveLength(1);

  // Freshness: a changed file is fetched again and the shown embed follows (SVG is text, so the file API can write it).
  const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><circle cx="${w / 2}" cy="${w / 2}" r="${w / 2 - 2}" fill="none" stroke="black"/></svg>`;
  await api.write(vault.id, 'ring.svg', svg(40));
  await openInRead(page, 'Fresh.md');
  await expect.poll(() => page.locator('.read .embed img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(40);
  expect(raws.filter((u) => u.includes('ring.svg'))).toHaveLength(1);
  await api.write(vault.id, 'ring.svg', svg(80));
  await expect.poll(() => page.locator('.read .embed img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(80);
  expect(raws.filter((u) => u.includes('ring.svg'))).toHaveLength(2);
});

test('video plays inline, pdf and missing files show a file card', async ({ page, vault }) => {
  push(vault, 'raw/media/clip.mp4', fixture('clip.mp4'));
  push(vault, 'raw/media/doc.pdf', fixture('doc.pdf'));
  push(vault, 'raw/media/wide.png', fixture('wide.png'));
  push(vault, 'Media.md', '# Media\n\n![[clip.mp4|200]]\n\n![[doc.pdf]]\n\n![[gone.png]]\n');
  push(vault, 'Off.md', '# Off\n\n![[wide.png]]\n');
  await openApp(page, vault.id);
  await openInRead(page, 'Media.md');

  const video = page.locator('.read .embed video[controls][playsinline]');
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect((await video.boundingBox())!.width).toBeLessThanOrEqual(200);

  const pdf = page.locator('[data-testid="file-card"][data-path="raw/media/doc.pdf"]');
  await expect(pdf).toContainText('doc.pdf');
  const dl = page.waitForEvent('download');
  await pdf.getByTestId('file-download').click();
  expect((await dl).suggestedFilename()).toBe('doc.pdf');

  const miss = page.locator('.file-card.miss');
  await expect(miss).toContainText('gone.png');
  await expect(miss.getByTestId('file-download')).toHaveCount(0);
});

// As in offline.spec.ts: the SW needs the launch flag on Chromium over the self-signed certificate.
test.use({ launchOptions: async ({ browserName }, use) => use(browserName === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {}) });

test('offline: an embed whose bytes are not cached is a file card that says so', async ({ page, context, vault, browserName }) => {
  // As in offline.spec.ts: Playwright's WebKit offline emulation bypasses the service worker's cache.
  test.skip(browserName === 'webkit', 'context.setOffline() in Playwright WebKit bypasses the service-worker cache fallback');
  push(vault, 'raw/media/wide.png', fixture('wide.png'));
  push(vault, 'Off.md', '# Off\n\n![[wide.png]]\n');
  await openApp(page, vault.id);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
  await page.reload();
  await expect(treeItem(page, 'Off.md')).toBeVisible();
  await openInRead(page, 'Home.md');
  // Put Off.md in the offline cache without showing it (its embed must not load while online).
  const token = await page.evaluate(() => localStorage.getItem('karpathy.token'));
  await page.evaluate(async ([id, t]) => { await fetch(`/api/vaults/${id}/file?path=Off.md`, { headers: { Authorization: `Bearer ${t}` } }); }, [vault.id, token]);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await treeItem(page, 'Off.md').click();
  await expect(page.locator('.note-title')).toHaveText('Off');
  await expect(page.locator('.read .file-card')).toContainText('offline');
  await expect(page.getByTestId('toast')).toHaveText(''); // no error toast
});

test('Open shows a pdf in a new tab', async ({ page, context, vault }) => {
  push(vault, 'raw/media/doc.pdf', fixture('doc.pdf'));
  push(vault, 'raw/media/x.bin', Buffer.from([0, 1, 2, 3]));
  push(vault, 'Docs.md', '# Docs\n\n![[doc.pdf]]\n\n![[x.bin]]\n');
  await openApp(page, vault.id);
  await openInRead(page, 'Docs.md');
  const bin = page.locator('[data-testid="file-card"][data-path="raw/media/x.bin"]');
  await expect(bin.getByTestId('file-download')).toBeVisible();
  await expect(bin.getByTestId('file-open')).toHaveCount(0);

  // The new tab navigates to a blob: URL. The browser's PDF viewer shows it; headless Chromium has none and
  // turns it into a download of that same URL, so take whichever happens.
  const target = new Promise<string>((resolve) => {
    context.on('page', (tab) => {
      tab.on('download', (d) => resolve(d.url()));
      tab.on('framenavigated', (f) => { if (f.url().startsWith('blob:')) resolve(f.url()); });
    });
  });
  await page.locator('[data-testid="file-card"][data-path="raw/media/doc.pdf"]').getByTestId('file-open').click();
  const url = await target;
  expect(url).toMatch(/^blob:/);
  // The blob was built by the app as application/pdf, whatever the response said. Reading it needs fetch(blob:),
  // which the prod CSP (connect-src 'self') forbids, so this check runs on the dev stack only.
  if (!(await page.request.head('/')).headers()['content-security-policy']) {
    expect(await page.evaluate(async (u) => (await (await fetch(u)).blob()).type, url)).toBe('application/pdf');
  }
});

test('large media loads only on request', async ({ page, api, vault }) => {
  backendExec('sh', '-c', `mkdir -p /vaults/${vault.id}/raw/media && truncate -s 51M /vaults/${vault.id}/raw/media/big.mp4`);
  await api.write(vault.id, 'Big.md', '# Big\n\n![[big.mp4]]\n');
  const gets: string[] = [];
  const bodies: number[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/raw?')) gets.push(r.url()); });
  page.on('requestfinished', async (r) => { if (r.method() === 'GET' && r.url().includes('/raw?')) bodies.push((await r.sizes()).responseBodySize); });
  await openApp(page, vault.id);
  await openInRead(page, 'Big.md');
  const card = page.getByTestId('file-card');
  await expect(card).toContainText('big.mp4');
  await expect(page.getByTestId('file-load')).toHaveText('Load anyway (51 MB)');
  await expect(page.locator('.read video')).toHaveCount(0);
  // Only the size was asked (HEAD): the body was never requested, let alone transferred.
  await page.waitForTimeout(500);
  expect(gets).toEqual([]);

  await page.getByTestId('file-load').click();
  await expect(page.locator('.read video')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => bodies.length).toBe(1);
  expect(gets).toHaveLength(1);
  expect(bodies[0]!).toBeGreaterThan(50_000_000);
});

test('tapping a media file shows it, a pdf shows a file card', async ({ page, api, vault }) => {
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  push(vault, 'raw/media/doc.pdf', fixture('doc.pdf'));
  const puts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
  await openApp(page, vault.id);
  await openInRead(page, 'Home.md'); // the stored mode is Read: opening a media file must leave it alone
  await revealInTree(page, 'raw/media/dot.png');
  await treeItem(page, 'raw/media/dot.png').click();
  await expect(page.locator('.note-title')).toHaveText('dot.png');
  await expect.poll(() => page.locator('#detail img[alt="dot.png"]').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(page.locator('#detail')).not.toContainText('Binary file');
  await expect(page.getByTestId('mode-toggle')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByTestId('delete-note')).toHaveAttribute('title', 'Delete file');

  // Delete works: the pane closes and the deletion is a change.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('delete-note').click();
  await expect(page.locator('.note-title')).toHaveCount(0);
  await expect.poll(async () => (await api.changes(vault.id)).map((c) => `${c.kind}:${c.path}`)).toContain('deleted:raw/media/dot.png');
  expect(puts).toEqual([]);

  await treeItem(page, 'raw/media/doc.pdf').click();
  await expect(page.locator('.note-title')).toHaveText('doc.pdf');
  await expect(page.locator('#detail').getByTestId('file-card')).toContainText('doc.pdf');
  await expect(page.getByTestId('file-open')).toBeVisible();

  // A note again: the mode is still Read, and the button says note.
  await treeItem(page, 'Home.md').click();
  await expect(page.locator('.note-title')).toHaveText('Home');
  await expect(page.getByTestId('mode-read')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('read-view')).toBeVisible();
  await expect(page.getByTestId('delete-note')).toHaveAttribute('title', 'Delete note');
});

test('Write mode shows the embed below its line, text stays editable', async ({ page, api, vault }) => {
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  push(vault, 'raw/media/doc.pdf', fixture('doc.pdf'));
  push(vault, 'Img.md', '# Img\n\nBefore.\n\n![[dot.png]]\n\nAfter.\n\n![[doc.pdf]]\n\nEnd.\n');
  await openApp(page, vault.id);
  await revealInTree(page, 'Img.md');
  await treeItem(page, 'Img.md').click();
  await expect(page.getByTestId('mode-write')).toHaveAttribute('aria-pressed', 'true');
  const img = page.locator('.cm-embed img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  const line = page.locator('.cm-line', { hasText: '![[dot.png]]' });
  await expect(line).toBeVisible(); // the raw text stays
  expect((await img.boundingBox())!.y).toBeGreaterThanOrEqual((await line.boundingBox())!.y + (await line.boundingBox())!.height - 1);
  await expect(page.locator('.cm-embed .file-card')).toContainText('doc.pdf');

  // Typing next to an embed keeps the same player (not recreated) and the text round-trips.
  await img.evaluate((e) => e.setAttribute('data-marker', 'same'));
  const before = (await api.file(vault.id, 'Img.md'))!.content;
  await line.click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await expect.poll(async () => (await api.file(vault.id, 'Img.md'))?.content, { timeout: 10_000 }).toBe(before.replace('![[dot.png]]', '![[dot.png]]x'));
  await expect(page.locator('.cm-embed img[data-marker="same"]')).toHaveCount(1);

});

// Tapping an image opens it as a media file; Back returns to the same place, even with images above it.
const tapAndBack = async ({ page, api, vault }: { page: Page; api: import('./helpers').Api; vault: TestVault }) => {
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  push(vault, 'raw/media/wide.png', fixture('wide.png'));
  const body = ['# Tall', '', ...Array.from({ length: 6 }, (_, i) => `![[wide.png]]\n\nParagraph ${i}.\n`), ...Array.from({ length: 30 }, (_, i) => `Filler ${i}.\n`), '![[dot.png]]', '', '![[clip.mp4]]', '', 'The end.', ''];
  push(vault, 'raw/media/clip.mp4', fixture('clip.mp4'));
  push(vault, 'Tall.md', body.join('\n'));
  await openApp(page, vault.id);
  const sc = page.locator('#detail .scroll');
  const tap = (loc: import('@playwright/test').Locator) => (test.info().project.name.includes('iphone') ? loc.tap() : loc.click());

  // Read mode.
  await openInRead(page, 'Tall.md');
  const dot = page.locator('.read .embed img[alt="dot.png"]');
  await expect.poll(() => dot.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(page.locator('.read .embed img[alt="wide.png"]')).toHaveCount(6);
  await dot.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  // A video keeps its own controls: clicking it doesn't navigate.
  const clip = page.locator('.read .embed video');
  await expect(clip).toBeVisible();
  await clip.click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.note-title')).toHaveText('Tall');
  await dot.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const before = await sc.evaluate((e) => e.scrollTop);
  expect(before).toBeGreaterThan(1500);
  await tap(dot);
  await expect(page.locator('.note-title')).toHaveText('dot.png');
  await page.goBack();
  await expect(page.locator('.note-title')).toHaveText('Tall');
  await expect(page.getByTestId('mode-read')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => Math.abs((await sc.evaluate((e) => e.scrollTop)) - before), { timeout: 5000 }).toBeLessThan(10);

  // Write mode: the same through the block widget (CodeMirror's pixel heights are estimates, so compare where the image is).
  // Within a second of Back, the Back's place restore is still running: the switch must stop it, or it pins
  // Read mode's pixel offset onto the Write view and fights the switch's own alignment.
  /** Text of the first line (Write) or block (Read) not hidden behind the header. */
  const firstVisible = (sel: string) => sc.evaluate((el, sel) => {
    const top = el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingTop);
    return [...el.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().bottom > top + 1 && e.textContent)?.textContent ?? '';
  }, sel);
  const readTop = await firstVisible('.read .rd > [data-line]');
  expect(readTop).toMatch(/^Filler \d+\.$/);
  await page.getByTestId('mode-write').click();
  await expect.poll(() => firstVisible('.cm-line'), { timeout: 600 }).toBe(readTop);
  const wdot = page.locator('.cm-embed img[alt="dot.png"]');
  // The cursor sits in a text line; a tap on the embed must not move it to the embed's line.
  await page.locator('.cm-line', { hasText: 'Filler 29.' }).scrollIntoViewIfNeeded().catch(() => {});
  await wdot.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  await page.locator('.cm-line', { hasText: /^Filler 29\.$/ }).click();
  await page.evaluate(() => {
    (window as unknown as { __sel?: string }).__sel = '';
    document.addEventListener('click', () => { (window as unknown as { __sel?: string }).__sel = getSelection()?.anchorNode?.textContent ?? ''; }, true);
  });
  // Players above are measured as they scroll into view and shift what is below: centre the image until it stays.
  for (let i = 0; i < 8; i++) {
    await wdot.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
  }
  const where = () => wdot.evaluate((e) => e.getBoundingClientRect().top - e.closest('.scroll')!.getBoundingClientRect().top);
  const wBefore = await where();
  await tap(wdot);
  await expect(page.locator('.note-title')).toHaveText('dot.png');
  const sel = await page.evaluate(() => (window as unknown as { __sel?: string }).__sel);
  expect(sel).not.toContain('dot.png');
  if (test.info().project.name === 'desktop') expect(sel).toContain('Filler 29.'); // WebKit reports no DOM selection here
  await page.goBack();
  await expect(page.locator('.note-title')).toHaveText('Tall');
  await expect.poll(async () => Math.abs((await where().catch(() => 9999)) - wBefore), { timeout: 8000 }).toBeLessThan(40);
  void api;
};
test('tap an image to open it, Back restores the scroll', async ({ page, api, vault }) => { await tapAndBack({ page, api, vault }); });
test('@iphone tap an image to open it, Back restores the scroll', async ({ page, api, vault }) => { await tapAndBack({ page, api, vault }); });

// Assistant text only exists after a real model turn (user prompts render as plain text), so this one is @llm.
test('@llm an embed in an assistant answer renders', async ({ page, vault }) => {
  test.setTimeout(15 * 60_000);
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  await openApp(page, vault.id);
  await expect(page.getByTestId('new-chat')).toBeVisible();
  await page.getByTestId('new-chat').click();
  const img = page.locator('.atext .embed img');
  // The small dev model sometimes adds words or drops the brackets: nudge it up to three times.
  const prompts = [
    'Reply with exactly this and nothing else: ![[dot.png]]',
    'Reply with exactly the text ![[dot.png]] including the exclamation mark and both pairs of square brackets. No other words.',
    'Say: ![[dot.png]]',
  ];
  for (const prompt of prompts) {
    await page.getByTestId('chat-composer').fill(prompt);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 8 * 60_000 }); // the turn is over
    if (await img.count()) break;
  }
  await expect(img.first()).toBeVisible();
  await expect.poll(() => img.first().evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
});

test('an SVG embed is sanitized: it renders, and its blob carries no script', async ({ page, vault }) => {
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" onload="window.__pwned=1"><script>window.__pwned=2</script><circle cx="15" cy="15" r="10"/></svg>';
  push(vault, 'raw/media/evil.svg', evil);
  push(vault, 'Svg.md', '# Svg\n\n![[evil.svg]]\n');
  await openApp(page, vault.id);
  await openInRead(page, 'Svg.md');
  const img = page.locator('.read .embed img');
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(30);
  // What "open image in new tab" would load: the blob. Reading it needs fetch(blob:), which the prod CSP forbids (dev only).
  if (!(await page.request.head('/')).headers()['content-security-policy']) {
    const text = await img.evaluate(async (e: HTMLImageElement) => (await fetch(e.src)).text());
    expect(text).toContain('<circle');
    expect(text).not.toMatch(/script|onload|__pwned/i);
  }
  // (Opened from the tree, an SVG is a text file: it opens as a note, editable, like any text.)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('an image inside a link keeps the link, a tap does not open the image', async ({ page, vault }) => {
  push(vault, 'raw/media/dot.png', fixture('dot.png'));
  push(vault, 'Link.md', '# Link\n\n[![](raw/media/dot.png)](https://example.invalid/x)\n');
  await openApp(page, vault.id);
  await openInRead(page, 'Link.md');
  const img = page.locator('.read a .embed img');
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(1);
  await expect(img).not.toHaveClass(/zoomable/);
  await expect(page.locator('.read a[href^="https://example.invalid"]')).toHaveAttribute('target', '_blank');
});
