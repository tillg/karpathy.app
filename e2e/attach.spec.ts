import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, makeConflict, openApp, openNote, pushFromObsidian, revealInTree, ROOT, test, treeItem, type TestVault } from './helpers';
import type { Page } from '@playwright/test';

// Uploads (attachments change): photo preparation, the editor's Attach button and drop, chat attachments.
const fixture = (name: string) => readFileSync(join(ROOT, 'e2e/fixtures/media', name));
// page.route must see the uploads (a service worker's fetches bypass it in WebKit, see fix-14).
test.use({ serviceWorkers: 'block' });

/** Runs `prepare` from lib/attach.ts in the page on a fixture; reports what came out. */
async function prepareInPage(page: Page, name: string, type: string) {
  return page.evaluate(async ([b64, name, type]) => {
    const bytes = Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
    const mod = '/src/lib/attach.ts';
    const { prepare } = await import(/* @vite-ignore */ mod);
    try {
      const out: { blob: Blob; name: string } = await prepare(new File([bytes], name!, { type }));
      const buf = new Uint8Array(await out.blob.arrayBuffer());
      let exif = false;
      for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xe1) { exif = true; break; }
      const img = new Image();
      img.src = URL.createObjectURL(out.blob);
      await img.decode().catch(() => undefined);
      return { ok: true, type: out.blob.type, name: out.name, size: buf.length, w: img.naturalWidth, h: img.naturalHeight, exif, same: buf.length === bytes.length && buf.every((v, i) => v === bytes[i]) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [fixture(name).toString('base64'), name, type]);
}

test.describe('photo preparation', () => {
  // lib/attach.ts is imported straight from the Vite dev server; prod images serve no /src.
  test.skip(!!process.env.E2E_BASE_URL, 'needs the dev stack');

  test('photo preparation', async ({ page, browserName }) => {
    await page.goto('/');
    const jpg = await prepareInPage(page, 'photo.jpg', 'image/jpeg');
    expect(jpg).toMatchObject({ ok: true, type: 'image/jpeg', name: 'photo.jpg', w: 1365, h: 2048, exif: false });
    expect(jpg.size).toBeLessThan(fixture('photo.jpg').length);
    for (const [name, type] of [['shot.png', 'image/png'], ['doc.pdf', 'application/pdf']] as const)
      expect(await prepareInPage(page, name, type), name).toMatchObject({ ok: true, name, same: true });
    const heic = await prepareInPage(page, 'photo.heic', 'image/heic');
    if (browserName === 'webkit') expect(heic).toMatchObject({ ok: true, type: 'image/jpeg', name: 'photo.jpg', w: 1365, h: 2048, exif: false });
    else expect(heic).toEqual({ ok: false, error: "HEIC photos can't be converted in this browser" });
  });
});

const push = (v: TestVault, path: string, content: string | Buffer) => pushFromObsidian(v.bare, path, content);
const changed = async (api: { changes: (id: string) => Promise<{ path: string }[]> }, v: TestVault) => (await api.changes(v.id)).map((c) => c.path);

/** Holds every upload POST until `release()` is called. */
async function holdUploads(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/vaults/*/raw?*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate;
    await route.fallback();
  });
  return () => release();
}

test('attach in the editor inserts an embed', async ({ page, api, vault }) => {
  const text = '# Home\nline two\nline three\n';
  push(vault, 'wiki/home/home.md', text);
  await openApp(page, vault.id);
  await openNote(page, 'wiki/home/home.md');
  await page.locator('.cm-line').nth(1).click();
  await page.keyboard.press('End');
  const release = await holdUploads(page);
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  // Typing elsewhere during the upload doesn't move where the embed goes.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('x');
  release();
  const img = page.locator('.cm-embed img');
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(400);
  await expect(page.locator('.cm-line').nth(2)).toHaveText('![[shot.png]]');
  const expected = 'x# Home\nline two\n![[shot.png]]\nline three\n';
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toBe(expected);
  expect(await changed(api, vault)).toContain('wiki/home/shot.png');
  await revealInTree(page, 'wiki/home/shot.png');
  await expect(treeItem(page, 'wiki/home/shot.png')).toBeVisible();

  // Undo removes the text only: the file stays.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.cm-content')).not.toContainText('![[shot.png]]');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toBe('x# Home\nline two\nline three\n');
  expect(await changed(api, vault)).toContain('wiki/home/shot.png');
});

test('attach to a flat page moves it, the editor follows', async ({ page, api, vault }) => {
  push(vault, 'wiki/flat.md', '# Flat\n');
  push(vault, 'wiki/ref.md', 'See [[wiki/flat]].\n');
  push(vault, 'wiki/flat2.md', '# Flat2\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/flat.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('hello');
  const historyBefore = await page.evaluate(() => history.length);
  const release = await holdUploads(page);
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' world');
  release();
  await expect(page).toHaveURL(new RegExp(`#/${vault.id}/wiki/flat/flat\\.md$`));
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await expect(page.locator('.cm-content')).toContainText('hello world');
  await expect(page.locator('.cm-embed img')).toHaveCount(1);
  await expect(page.getByTestId('toast')).toContainText('updated links in 1 page');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/flat/flat.md'))?.content).toMatch(/^# Flat\nhello world\n!\[\[shot\.png\]\]\n?$/);
  expect(await api.file(vault.id, 'wiki/flat.md')).toBeNull();
  expect((await api.file(vault.id, 'wiki/ref.md'))?.content).toBe('See [[wiki/flat/flat]].\n');
  await expect(page.getByTestId('save-state')).toHaveText(/^Saved/);

  // After a reload the draft key and the route are the new path's: no restored or stale draft.
  await page.reload();
  await expect(page.locator('.note-title')).toHaveText('flat');
  await expect(page.locator('.cm-content')).toContainText('hello world');
  await expect(page.getByTestId('save-state')).toHaveText(/^Saved/);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('karpathy.draft')))).toEqual([]);

  // Several files go one after another; after the first moved the page, the rest name the moved page.
  await openNote(page, 'wiki/flat2.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  const posts: { note: string; start: number; end?: number }[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/raw?')) posts.push({ note: new URL(r.url()).searchParams.get('note')!, start: Date.now() }); });
  page.on('requestfinished', (r) => { if (r.method() === 'POST' && r.url().includes('/raw?')) posts.find((p) => p.note === new URL(r.url()).searchParams.get('note') && !p.end)!.end = Date.now(); });
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles([join(ROOT, 'e2e/fixtures/media/shot.png'), join(ROOT, 'e2e/fixtures/media/doc.pdf')]);
  await expect.poll(async () => (await api.file(vault.id, 'wiki/flat2/flat2.md'))?.content).toBe('# Flat2\n![[shot-2.png]]\n![[doc.pdf]]');
  expect(posts.map((p) => p.note)).toEqual(['wiki/flat2.md', 'wiki/flat2/flat2.md']);
  expect(posts[1]!.start).toBeGreaterThanOrEqual(posts[0]!.end!);
  expect((await api.files(vault.id)).map((f) => f.path)).toEqual(expect.arrayContaining(['wiki/flat2/shot-2.png', 'wiki/flat2/doc.pdf']));
});

/** Dispatches dragenter/dragover/drop with `files` at the right end of `target`; checks the outline during the drag. */
async function dropFiles(page: Page, target: ReturnType<Page['locator']>, files: { name: string; type: string; b64: string }[], outline = true) {
  const box = (await target.boundingBox())!;
  const at = { x: box.x + box.width - 4, y: box.y + box.height / 2 };
  const dt = await page.evaluateHandle((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    return dt;
  }, files);
  const el = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y)!, at);
  const opts = { dataTransfer: dt, clientX: at.x, clientY: at.y };
  await el.evaluate((e, o) => { for (const type of ['dragenter', 'dragover']) e.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, ...o })); }, opts);
  if (outline) await expect(page.getByTestId('editor').locator('.cm-editor')).toHaveClass(/cm-drop-target/);
  return el.evaluate((e, o) => e.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, ...o })), opts);
}
const asDrop = (name: string, type: string) => ({ name, type, b64: fixture(name).toString('base64') });

test('a moved page keeps its rewritten relative links', async ({ page, api, vault }) => {
  push(vault, 'wiki/img.png', fixture('dot.png'));
  push(vault, 'wiki/rel.md', '# Rel\n![](img.png)\n');
  push(vault, 'wiki/rel2.md', '# Rel2\n![](img.png)\n');
  await openApp(page, vault.id);
  // Nothing typed during the upload: the editor takes the server's rewritten text.
  await openNote(page, 'wiki/rel.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  await expect(page).toHaveURL(/wiki\/rel\/rel\.md$/);
  await expect(page.locator('.cm-content')).toContainText('![](../img.png)');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/rel/rel.md'))?.content).toBe('# Rel\n![](../img.png)\n![[shot.png]]');
  await page.waitForTimeout(2000); // past autosave: nothing writes the old links back
  expect((await api.file(vault.id, 'wiki/rel/rel.md'))?.content).toBe('# Rel\n![](../img.png)\n![[shot.png]]');

  // Typed during the upload: the local text gets the same rewrite.
  await openNote(page, 'wiki/rel2.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  const release = await holdUploads(page);
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/wide.png'));
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('x');
  release();
  await expect(page).toHaveURL(/wiki\/rel2\/rel2\.md$/);
  await expect.poll(async () => (await api.file(vault.id, 'wiki/rel2/rel2.md'))?.content).toBe('x# Rel2\n![](../img.png)\n![[wide.png]]');
});

test('an upload finishing after the note was left still embeds the file', async ({ page, api, vault }) => {
  push(vault, 'wiki/home/home.md', '# Home\n');
  push(vault, 'wiki/other/other.md', '# Other\n');
  await openApp(page, vault.id);
  // Switched to Read mode during the upload.
  await openNote(page, 'wiki/home/home.md');
  let release = await holdUploads(page);
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  await page.getByTestId('mode-read').click();
  release();
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toContain('![[shot.png]]');
  await expect(page.locator('.read .embed img')).toHaveCount(1);
  await page.getByTestId('mode-write').click();
  await page.unrouteAll();

  // Another note opened during the upload: the file is still embedded in the first, and the other one autosaves.
  release = await holdUploads(page);
  await page.getByTestId('attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/wide.png'));
  await openNote(page, 'wiki/other/other.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('typed');
  release();
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toContain('![[wide.png]]');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/other/other.md'))?.content).toContain('typed');
});

test('drop files into the editor', async ({ page, api, vault, browserName }) => {
  // A synthesized DataTransfer drop with files isn't reliable in WebKit: Safari is checked by hand (phase 6).
  test.skip(browserName !== 'chromium', 'Chromium only');
  push(vault, 'wiki/home/home.md', '# Home\nline two\nline three\nline four\nline five\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/home/home.md');
  const notCancelled = await dropFiles(page, page.locator('.cm-line').nth(3), [asDrop('shot.png', 'image/png'), asDrop('doc.pdf', 'application/pdf')]);
  expect(notCancelled).toBe(false);
  const want = '# Home\nline two\nline three\nline four\n![[shot.png]]\n![[doc.pdf]]\nline five\n';
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toBe(want);
  await expect(page.getByTestId('editor').locator('.cm-editor')).not.toHaveClass(/cm-drop-target/);

  // A file that can't be uploaded is refused by name; the others still go in.
  await dropFiles(page, page.locator('.cm-line').first(), [{ name: 'notes.txt', type: 'text/plain', b64: btoa('hi') }, asDrop('dot.png', 'image/png')]);
  await expect(page.getByTestId('toast')).toContainText('notes.txt');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toBe(want.replace('# Home\n', '# Home\n![[dot.png]]\n'));
  expect((await api.files(vault.id)).map((f) => f.path).filter((p) => p.includes('notes'))).toEqual([]);

  // Read mode: the drop is swallowed (no upload, no navigation to the file).
  await page.getByTestId('mode-read').click();
  const url = page.url();
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/raw?')) posts.push(r.url()); });
  expect(await dropFiles(page, page.getByTestId('read-view'), [asDrop('shot.png', 'image/png')], false)).toBe(false);
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  expect(page.url()).toBe(url);
});

test('embed text and button visibility', async ({ page, context, api, vault }) => {
  push(vault, 'other/shot.png', fixture('dot.png'));
  push(vault, 'wiki/home/home.md', '# Home\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/home/home.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.getByTestId('attach').click();
  const photo = page.getByTestId('attach-photo').locator('input');
  await expect(photo).toHaveAttribute('capture', 'environment');
  await expect(photo).toHaveAttribute('accept', 'image/jpeg');
  await expect(page.getByTestId('attach-choose').locator('input')).toHaveAttribute('accept', 'image/jpeg,image/png,image/gif,image/webp,application/pdf');
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  // The name is taken elsewhere in the vault: the new file gets -2, and the bare embed shows it, not the other one.
  await expect.poll(async () => (await api.file(vault.id, 'wiki/home/home.md'))?.content).toBe('# Home\n![[shot-2.png]]');
  await expect.poll(() => page.locator('.cm-embed img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(400);

  // Read mode, a media file, offline and in conflict: no Attach button.
  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('read-view')).toBeVisible();
  await expect(page.getByTestId('attach')).toHaveCount(0);
  await page.getByTestId('mode-write').click();
  await expect(page.getByTestId('attach')).toBeVisible();
  await revealInTree(page, 'wiki/home/shot-2.png');
  await treeItem(page, 'wiki/home/shot-2.png').click();
  await expect(page.locator('.media-view')).toBeVisible();
  await expect(page.getByTestId('attach')).toHaveCount(0);
  await openNote(page, 'wiki/home/home.md');
  await expect(page.getByTestId('attach')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(page.getByTestId('attach')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByTestId('attach')).toBeVisible();
  await makeConflict(api, vault);
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await expect(page.getByTestId('attach')).toHaveCount(0);
});

test('growth warning and refusals', async ({ page, api, vault }) => {
  push(vault, 'wiki/home/home.md', '# Home\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/home/home.md');
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/raw?')) posts.push(r.url()); });
  const big = { name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024)]) };
  const pick = async (file: typeof big) => {
    await page.getByTestId('attach').click();
    await page.getByTestId('attach-choose').setInputFiles(file);
  };
  const dialogs: string[] = [];
  page.once('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await pick(big);
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('11 MB');
  expect(dialogs[0]).toContain('git history');
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  page.once('dialog', (d) => void d.accept());
  await pick(big);
  await expect.poll(async () => (await api.files(vault.id)).map((f) => f.path)).toContain('wiki/home/big.pdf');

  // `accept` only filters the picker: a .txt still arrives here and is refused.
  const before = await api.changes(vault.id);
  await pick({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(page.getByTestId('toast')).toContainText('Only JPEG, PNG, GIF, WebP and PDF can be uploaded.');
  expect(await api.changes(vault.id)).toEqual(before);
});

test('attach in the chat', async ({ page, api, vault }) => {
  page.on('dialog', (d) => void d.accept());
  const settings = (await (await api.ctx.get('/api/settings')).json()) as { model: string; modelInput: { image: boolean; pdf: boolean } | null };
  await openApp(page, vault.id);
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/raw?')) posts.push(decodeURIComponent(r.url())); });
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeEnabled();
  const pickInChat = async (...files: string[]) => {
    await page.getByTestId('chat-attach').click();
    await page.getByTestId('attach-choose').setInputFiles(files.map((f) => join(ROOT, 'e2e/fixtures/media', f)));
  };
  const chips = page.getByTestId('attach-chip');
  /** A reload lands on the chat list: open the chat again. */
  const reload = async () => {
    await page.reload();
    await page.getByTestId('chat-item').first().click();
    await expect(page.getByTestId('chat-composer')).toBeEnabled();
  };
  const uploads = async () => (await api.files(vault.id)).map((f) => f.path).filter((p) => /^Sources\/upload-/.test(p));

  // 1. Two files → two chips in one new source folder.
  await pickInChat('shot.png', 'doc.pdf');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0).locator('img')).toBeVisible();
  await expect(chips.nth(1)).toContainText('doc.pdf');
  await expect(chips.nth(1)).toContainText(/\d+ B/);
  const files = (await uploads()).filter((p) => !p.endsWith('/') && /\.(png|pdf)$/.test(p));
  expect(files).toHaveLength(2);
  const folder = files[0]!.split('/').slice(0, 2).join('/');
  expect(files.every((p) => p.startsWith(`${folder}/`))).toBe(true);
  if (settings.modelInput && !settings.modelInput.image)
    await expect(chips.nth(0)).toContainText(`${settings.model.split('/').pop()} can’t see images`);

  // 2. ✕ deletes the file; the last one takes its folder with it, and the next file starts a new one.
  await chips.nth(1).getByTestId('attach-chip-remove').click();
  await expect(chips).toHaveCount(1);
  await expect.poll(async () => (await uploads()).some((p) => p.endsWith('doc.pdf'))).toBe(false);
  expect((await api.changes(vault.id)).map((c) => c.path).some((p) => p.endsWith('doc.pdf'))).toBe(false);
  await chips.nth(0).getByTestId('attach-chip-remove').click();
  await expect(chips).toHaveCount(0);
  await expect.poll(async () => (await api.files(vault.id)).some((f) => f.path === folder)).toBe(false);
  posts.length = 0;
  await pickInChat('shot.png');
  await expect(chips).toHaveCount(1);
  expect(posts[0]).toContain('source=new');

  // 3. An unsent chip survives a reload; one whose file is gone is dropped.
  await reload();
  await expect(chips).toHaveCount(1);
  await expect(chips.nth(0).locator('img')).toBeVisible();
  const [png] = (await uploads()).filter((p) => p.endsWith('.png'));
  const del = async (path: string) => {
    const f = await api.file(vault.id, path);
    expect((await api.ctx.delete(`/api/vaults/${vault.id}/file?path=${encodeURIComponent(path)}&version=${f!.version}`)).status()).toBe(204);
  };
  await del(png!);
  await reload();
  await expect(chips).toHaveCount(0);

  // 4. Sent with empty text: the message shows the image through /raw, not as a data: URL.
  await pickInChat('shot.png');
  await expect(chips).toHaveCount(1);
  const raws: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/raw?')) raws.push(decodeURIComponent(r.url())); });
  await reload();
  await expect(chips).toHaveCount(1);
  await page.getByTestId('chat-send').click();
  const sent = page.locator('#chat .u .embed img');
  await expect(sent).toHaveCount(1);
  expect(await sent.getAttribute('src')).toMatch(/^blob:/);
  expect(raws.some((u) => u.includes('/raw?path=Sources/upload-'))).toBe(true);
  await expect(chips).toHaveCount(0);
  if (await page.getByTestId('chat-stop').isVisible()) await page.getByTestId('chat-stop').click();

  // 5. Still shown after a reload; a deleted file shows the missing card.
  await reload();
  await expect(page.locator('#chat .u .embed img')).toHaveCount(1);
  const [sentPath] = (await uploads()).filter((p) => p.endsWith('.png'));
  await expect(page.getByTestId('chat-send')).toBeVisible({ timeout: 60_000 });
  await del(sentPath!);
  await reload();
  await expect(page.locator('#chat .u .embed.miss [data-testid="file-card"]')).toHaveCount(1);

  // 6. The next message's first file gets a new folder named after the browser's local time.
  await page.clock.setFixedTime(new Date(2026, 9, 4, 9, 15, 0));
  posts.length = 0;
  await pickInChat('shot.png');
  await expect(chips).toHaveCount(1);
  expect(posts[0]).toContain('source=new&at=2026-10-04-091500');
  expect((await uploads()).some((p) => p.startsWith('Sources/upload-2026-10-04-091500/'))).toBe(true);

  // 8. At most five files per message.
  await pickInChat('dot.png', 'wide.png', 'doc.pdf', 'photo.jpg', 'clip.mp4');
  await expect(page.getByTestId('toast')).toContainText('At most 5 files per message');
  await expect(chips).toHaveCount(1);
});

test('opening a chat reads the settings again (the model may have changed since the app loaded)', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await expect(page.getByTestId('new-chat')).toBeVisible();
  const reads: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/settings') reads.push(r.url()); });
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeEnabled();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
});

test('a sent photo shows in the pending message right away', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeEnabled();
  await page.getByTestId('chat-attach').click();
  await page.getByTestId('attach-choose').setInputFiles(join(ROOT, 'e2e/fixtures/media/shot.png'));
  await expect(page.getByTestId('attach-chip')).toHaveCount(1);
  // The prompt is held: only the pending bubble can show the photo.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/prompt', async (route) => { await gate; await route.fallback(); });
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-pending').locator('.embed img')).toBeVisible();
  release();
  if (await page.getByTestId('chat-stop').isVisible().catch(() => false)) await page.getByTestId('chat-stop').click();
});

test('@iphone attach menu and chips fit the composer', async ({ page, vault }) => {
  // Five uploads are five uncommitted changes: the commit reminder isn't what this is about.
  const reminder = page.getByTestId('reminder-dialog');
  await page.addLocatorHandler(reminder, () => reminder.getByRole('button', { name: 'Later' }).click());
  await openApp(page, vault.id);
  await page.getByTestId('tab-chat').click();
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-composer')).toBeEnabled();
  await page.getByTestId('chat-attach').click();
  for (const id of ['attach-photo', 'attach-choose']) {
    const item = page.getByTestId(id);
    await expect(item).toBeInViewport({ ratio: 1 });
    // After the menu's pop-in animation (it starts at 96 % size).
    await expect.poll(async () => (await item.boundingBox())!.height, { message: id }).toBeGreaterThanOrEqual(44);
  }
  await page.getByTestId('attach-choose').setInputFiles(['shot.png', 'dot.png', 'wide.png', 'doc.pdf', 'photo.jpg'].map((f) => join(ROOT, 'e2e/fixtures/media', f)));
  await expect(page.getByTestId('attach-chip')).toHaveCount(5);
  await expect(reminder).toBeHidden();
  const row = page.getByTestId('attach-chips');
  expect(await row.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto')).toBe(true);
  await expect(page.getByTestId('chat-send')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('attach-chip').last()).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'tmp/attach-iphone-chips.png' });
});
