import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, makeConflict, openApp, openNote, pushFromObsidian, ROOT, test, type Api, type TestVault } from './helpers';

// Properties form in Write mode (#82, note-outline-properties).

export const PROPS = readFileSync(join(ROOT, 'apps/web/src/lib/fixtures/props.md'), 'utf8');
const FM_LINES = PROPS.split('\n---\n')[0]!.split('\n').length + 1;

async function openProps(page: Page, api: Api, vault: TestVault, path = 'Props.md', text = PROPS) {
  await api.write(vault.id, path, text);
  await openApp(page, vault.id);
  await openNote(page, path);
}

test('form view hides the frontmatter, YAML shows it', async ({ page, api, vault }) => {
  await api.write(vault.id, 'Other.md', '---\na: 1\n---\n# Other\n');
  await openProps(page, api, vault);
  await expect(page.getByTestId('props')).toBeVisible();
  await expect(page.getByTestId('props-row').first()).toBeVisible();
  await expect(page.locator('.cm-fm')).toHaveCount(0);
  await expect(page.locator('.cm-line').first()).toHaveText('# Props');

  await page.getByTestId('props-yaml').click();
  await expect(page.getByTestId('props-row')).toHaveCount(0);
  await expect(page.locator('.cm-fm')).toHaveCount(FM_LINES);

  await page.reload();
  await openNote(page, 'Other.md');
  await expect(page.locator('.cm-fm')).toHaveCount(3);
  await expect(page.getByTestId('props-row')).toHaveCount(0);

  // The cursor in a frontmatter line (editing the YAML) doesn't keep the form from coming back.
  await page.locator('.cm-fm', { hasText: 'a: 1' }).click();
  await page.getByTestId('props-form').click();
  await expect(page.getByTestId('props-row')).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('props-row')).toHaveCount(1);
  await openNote(page, 'Home.md');
  await expect(page.getByTestId('props')).toHaveCount(0);
  await openNote(page, 'Props.md');
  await page.getByTestId('mode-read').click();
  await expect(page.locator('.read .props')).toBeVisible();
  await expect(page.getByTestId('props')).toHaveCount(0);
});

const WIKI = `---
type: concept
tags: [a, b]
updated: 2026-10-02
related: ["[[Ideas]]"]
confidence: very-high
kind: tour
summary: |
  two
  lines
---
# p
`;

const row = (page: Page, key: string) => page.locator(`[data-testid="props-row"][data-key="${key}"]`);

test('rows and flags', async ({ page, api, vault }) => {
  await api.write(vault.id, 'Sources/p.md', WIKI);
  await openProps(page, api, vault, 'wiki/p.md', WIKI); // the e2e vault has `wiki/`; the schema's `Wiki/` matches it
  await expect(row(page, 'type').locator('select')).toHaveValue('concept');
  await expect(row(page, 'updated').locator('input[type="date"]')).toHaveValue('2026-10-02');
  await expect(row(page, 'kind').locator('input[type="text"]')).toHaveValue('tour');
  await expect(row(page, 'tags').locator('.chip-label')).toHaveText(['a', 'b']);
  await expect(row(page, 'summary')).toContainText('Edit in YAML');
  await expect(row(page, 'summary').locator('input, select')).toHaveCount(0);
  await expect(page.getByTestId('props-violation')).toHaveCount(1);
  await expect(row(page, 'confidence').getByTestId('props-violation')).toHaveText('must be high, medium or low');
  await row(page, 'related').locator('a.wl', { hasText: 'Ideas' }).click();
  await expect(page.locator('.note-title')).toHaveText('Ideas');

  await openNote(page, 'Sources/p.md');
  await expect(row(page, 'confidence')).toBeVisible();
  await expect(page.getByTestId('props-violation')).toHaveCount(0);
});

/** Line numbers (1-based) where two texts differ; both must have the same line count. */
function changedLines(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n');
  expect(y.length).toBe(x.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [i + 1]));
}
const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveText(/^Saved/, { timeout: 15_000 });

test('one field, one line', async ({ page, api, vault }) => {
  const path = 'wiki/Props.md';
  await openProps(page, api, vault, path);
  const file = async () => (await api.file(vault.id, path))!.content;

  await row(page, 'confidence').locator('select').selectOption('medium');
  await expect.poll(async () => changedLines(PROPS, await file())).toEqual([6]);
  expect((await file()).split('\n')[5]).toBe("confidence: 'medium' # why: two sources agree");

  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await row(page, 'updated').getByRole('button', { name: 'Today' }).click();
  await expect.poll(async () => changedLines(PROPS, await file())).toEqual([5, 6]);
  expect((await file()).split('\n')[4]).toBe(`updated: ${today}`);

  // Each form edit is one undo step in the editor.
  await page.locator('.cm-line', { hasText: 'Body text.' }).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(file).toBe(PROPS);
  await saved(page);

  // A CRLF note keeps CRLF on every line.
  const crlf = PROPS.replace(/\n/g, '\r\n');
  await api.write(vault.id, 'wiki/Crlf.md', crlf);
  await openNote(page, 'wiki/Crlf.md');
  await row(page, 'confidence').locator('select').selectOption('medium');
  await expect.poll(async () => changedLines(crlf, (await api.file(vault.id, 'wiki/Crlf.md'))!.content)).toEqual([6]);
  expect((await api.file(vault.id, 'wiki/Crlf.md'))!.content.replace(/\r\n/g, '')).not.toContain('\n');
});

test('link chips', async ({ page, api, vault }) => {
  const head = 'type: concept\ntags: []\nupdated: 2026-10-02\n';
  await api.write(vault.id, 'wiki/Bare.md', `---\n${head}related: [dolomites]\n---\n# Bare\n`);
  await openProps(page, api, vault, 'wiki/Links.md', `---\n${head}related: ["[[a]]"]\n---\n# Links\n`);
  const line = async (path: string, key: string) => (await api.file(vault.id, path))!.content.split('\n').find((l) => l.startsWith(`${key}:`));
  const add = (key: string) => row(page, key).locator('.props-add-input');

  await add('related').fill('ide');
  await page.getByTestId('props-suggestion').filter({ hasText: /^Ideas$/ }).click();
  await expect.poll(() => line('wiki/Links.md', 'related')).toBe('related: ["[[a]]", "[[Ideas]]"]');
  await row(page, 'related').getByRole('button', { name: 'Remove [[a]]' }).click();
  await expect.poll(() => line('wiki/Links.md', 'related')).toBe('related: ["[[Ideas]]"]');

  await add('tags').fill('x');
  await add('tags').press('Enter');
  await add('tags').fill('y');
  await add('tags').press('Enter');
  await expect(row(page, 'tags').locator('.chip-label')).toHaveText(['x', 'y']);
  await expect(add('tags')).toBeFocused();
  await expect.poll(() => line('wiki/Links.md', 'tags')).toBe('tags: [x, y]');

  await openNote(page, 'wiki/Bare.md');
  await add('related').fill('Ideas');
  await add('related').press('Enter');
  await expect.poll(() => line('wiki/Bare.md', 'related')).toBe('related: [dolomites, Ideas]');
});

test('never a lossy write', async ({ page, api, vault }) => {
  // (1) A pull changes `type` while the form is open: the form follows, a later edit keeps the pulled change.
  pushFromObsidian(vault.bare, 'wiki/Props.md', PROPS);
  pushFromObsidian(vault.bare, 'wiki/Other.md', '---\na: 1\n---\n# Other\n');
  await openApp(page, vault.id);
  await openNote(page, 'wiki/Props.md');
  await expect(row(page, 'type').locator('select')).toHaveValue('synthesis');
  const pulled = PROPS.replace('type: synthesis', 'type: concept');
  pushFromObsidian(vault.bare, 'wiki/Props.md', pulled);
  expect((await api.ctx.post(`/api/vaults/${vault.id}/pull`)).ok()).toBe(true);
  await expect(row(page, 'type').locator('select')).toHaveValue('concept');
  await row(page, 'confidence').locator('select').selectOption('medium');
  await expect.poll(async () => (await api.file(vault.id, 'wiki/Props.md'))!.content).toBe(pulled.replace("'high'", "'medium'"));

  // (2) A flow list over two lines is read-only; "Edit in YAML" shows the lines for this note only.
  const flow = '---\ntype: concept\naliases: [a,\n  b]\n---\n# Flow\n';
  await api.write(vault.id, 'wiki/Flow.md', flow);
  await openNote(page, 'wiki/Flow.md');
  await row(page, 'aliases').getByRole('button', { name: 'Edit in YAML' }).click();
  await expect(page.getByTestId('props-row')).toHaveCount(0);
  await expect(page.locator('.cm-fm')).toHaveCount(5);
  expect((await api.file(vault.id, 'wiki/Flow.md'))!.content).toBe(flow);
  await openNote(page, 'wiki/Other.md');
  await expect(page.getByTestId('props-row')).toHaveCount(1);

  // (3) Unreadable frontmatter: a message and the YAML lines; the preference stays the form.
  await api.write(vault.id, 'wiki/Dup.md', '---\na: 1\na: 2\n---\n# Dup\n');
  await openNote(page, 'wiki/Dup.md');
  await expect(page.getByTestId('props-unreadable')).toContainText('Can’t read these properties');
  await expect(page.locator('.cm-fm')).toHaveCount(4);
  await openNote(page, 'wiki/Other.md');
  await expect(page.getByTestId('props-row')).toHaveCount(1);
});

test('hits in the frontmatter are visible', async ({ page, api, vault }) => {
  await api.write(vault.id, 'wiki/Other.md', '---\na: 1\n---\n# Other\n');
  await openProps(page, api, vault, 'wiki/Props.md');
  const line = PROPS.split('\n').findIndex((l) => l.includes('Ötztal')) + 1;
  const headLine = () => page.locator('.cm-content').evaluate((e) => {
    const v = (e as unknown as { cmTile: { view: { state: { doc: { lineAt(p: number): { number: number } }; selection: { main: { head: number } } } } } }).cmTile.view;
    return v.state.doc.lineAt(v.state.selection.main.head).number;
  });

  await page.getByTestId('section-search').click();
  await page.getByTestId('search-input').fill('Ötztal');
  await page.locator('[data-testid="search-result"][data-path="wiki/Props.md"]').click();
  await expect(page.locator('.cm-fm').first()).toBeVisible();
  await expect.poll(headLine).toBe(line);

  await page.getByTestId('section-files').click();
  await openNote(page, 'wiki/Other.md');
  await openNote(page, 'wiki/Props.md');
  await expect(page.locator('.cm-fm')).toHaveCount(0);
  await page.getByTestId('find-in-note').click();
  await page.keyboard.type('Ötztal');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-fm').first()).toBeVisible();
  await expect.poll(headLine).toBe(line);
});

test('schema file', async ({ page, api, vault }) => {
  const schema = (values: string[]) => JSON.stringify({ appliesTo: ['People/'], fields: { type: { kind: 'enum', values, required: true } } });
  await api.write(vault.id, '.karpathy/schema.json', schema(['person']));
  await api.write(vault.id, 'People/a.md', '---\ntype: entity\n---\n# a\n');
  await api.write(vault.id, 'wiki/p.md', '---\ntype: concept\ntags: [a]\nupdated: 2026-10-02\nconfidence: very-high\n---\n# p\n');
  await openApp(page, vault.id);
  await openNote(page, 'People/a.md');
  await expect(row(page, 'type').getByTestId('props-violation')).toHaveText('must be person');
  await openNote(page, 'wiki/p.md');
  await expect(page.getByTestId('props-violation')).toHaveCount(0);

  // A new schema file applies without a page reload.
  await openNote(page, 'People/a.md');
  await api.write(vault.id, '.karpathy/schema.json', schema(['person', 'entity']));
  await expect(page.getByTestId('props-violation')).toHaveCount(0);

  // A broken one is ignored once, with a toast; the default rules apply.
  await api.write(vault.id, '.karpathy/schema.json', '{ not json');
  await expect(page.getByTestId('toast')).toContainText('Schema file ignored');
  await openNote(page, 'wiki/p.md');
  await expect(row(page, 'confidence').getByTestId('props-violation')).toHaveText('must be high, medium or low');

  // It is a vault file like any other: hidden in the tree, and chat stays available.
  await expect(page.locator('[data-testid="tree-item"][data-path=".karpathy"]')).toHaveCount(0);
  expect((await api.ctx.post(`/api/vaults/${vault.id}/chats`, { data: {} })).status()).not.toBe(409);
});

test('@iphone form', async ({ page, api, vault }) => {
  await openProps(page, api, vault, 'wiki/Phone.md', `---\ntype: entity\ntags: [a]\nupdated: 2026-10-02\nrelated: ["[[Ideas]]"]\nsummit_m: 3606\nsummary: |\n  two\n---\n# Phone\n`);
  const add = row(page, 'tags').locator('.props-add-input');
  await expect(add).toHaveAttribute('enterkeyhint', 'done');
  await expect(add).toHaveAttribute('autocapitalize', 'off');
  await expect(add).toHaveAttribute('autocorrect', 'off');
  await expect(row(page, 'summit_m').locator('input')).toHaveAttribute('inputmode', 'decimal');
  const small = await page.getByTestId('props').locator('button, input, select').evaluateAll((els) =>
    els.map((e) => [e.outerHTML.slice(0, 80), e.getBoundingClientRect().height] as const).filter(([, h]) => h < 44));
  expect(small).toEqual([]);
  const pane = page.locator('#detail .scroll');
  expect(await pane.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
  await add.fill('b');
  await add.press('Enter');
  await expect(row(page, 'tags').locator('.chip-label')).toHaveText(['a', 'b']);
  await expect(add).toBeFocused();
});

test('read-only in conflict', async ({ page, api, vault }) => {
  await api.write(vault.id, 'wiki/Props.md', PROPS);
  await makeConflict(api, vault);
  await openApp(page, vault.id);
  await openNote(page, 'wiki/Props.md');
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  const controls = page.getByTestId('props').locator('input, select, .chip-x, .props-btn');
  expect(await controls.count()).toBeGreaterThan(5);
  expect(await controls.evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).disabled).map((e) => e.outerHTML.slice(0, 60)))).toEqual([]);
});

test('the hidden frontmatter is safe from editing keys', async ({ page, api, vault }) => {
  const note = '---\ntitle: x\n---\n# H\n\nBody.\n';
  await openProps(page, api, vault, 'Guard.md', note);
  const doc = () => page.locator('.cm-content').evaluate((e) => (e as unknown as { cmTile: { view: { state: { doc: { toString(): string } } } } }).cmTile.view.state.doc.toString());
  const head = () => page.locator('.cm-content').evaluate((e) => (e as unknown as { cmTile: { view: { state: { selection: { main: { head: number } } } } } }).cmTile.view.state.selection.main.head);
  const bodyStart = note.indexOf('# H');

  // ArrowUp from the first body line stays below the hidden lines.
  await page.locator('.cm-line', { hasText: '# H' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  expect(await head()).toBeGreaterThanOrEqual(bodyStart);
  await expect(page.locator('.cm-fm')).toHaveCount(0);

  // Backspace at the start of the body would join it to the closing `---`: refused, and the lines are shown.
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.cm-fm').first()).toBeVisible();
  expect(await doc()).toBe(note);

  // Select all, then type: in the form view the properties aren't part of the selection.
  await page.getByTestId('props-form').click();
  await expect(page.locator('.cm-fm')).toHaveCount(0);
  await page.locator('.cm-line', { hasText: 'Body.' }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('New');
  expect(await doc()).toBe('---\ntitle: x\n---\nNew');
});

test('a broken schema file is reported once', async ({ page, api, vault }) => {
  const other = await api.createVault('schema-other');
  try {
    await openProps(page, api, vault, 'wiki/p.md', '---\ntype: concept\n---\n# p\n');
    const toast = page.getByTestId('toast');
    await api.write(vault.id, '.karpathy/schema.json', '{ not json');
    await expect(toast).toContainText('Schema file ignored');
    await expect(toast).not.toHaveClass(/\bon\b/, { timeout: 10_000 });
    // Away to another vault and back: the same broken file is not reported again.
    await toast.evaluate((el) => {
      const w = window as unknown as { shown: string[] };
      w.shown = [];
      new MutationObserver(() => { if (el.classList.contains('on')) w.shown.push(el.textContent ?? ''); }).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
    });
    for (const id of [other.id, vault.id]) {
      await page.getByTestId('vault-switcher').first().click();
      await page.locator(`[data-testid="vault-option"][data-vault="${id}"]`).click();
      await expect(page.getByTestId('vault-switcher').first()).toContainText(id);
    }
    await page.waitForTimeout(2500);
    expect((await page.evaluate(() => (window as unknown as { shown: string[] }).shown)).filter((t) => t.includes('Schema file ignored'))).toEqual([]);
  } finally {
    await api.removeVault(other.id);
  }
});

test('a number field writes what was typed', async ({ page, api, vault }) => {
  await openProps(page, api, vault, 'Num.md', '---\nsummit_m: 3606\n---\n# n\n');
  const input = row(page, 'summit_m').locator('input');
  await input.fill('3607');
  await input.press('Enter');
  await expect.poll(async () => (await api.file(vault.id, 'Num.md'))!.content.split('\n')[1]).toBe('summit_m: 3607');
  // Not a plain number as typed: kept as text, not rewritten as 7.
  await input.fill('007');
  await input.press('Enter');
  await expect.poll(async () => (await api.file(vault.id, 'Num.md'))!.content.split('\n')[1]).toBe('summit_m: "007"');
});

test('+ Property', async ({ page, api, vault }) => {
  await openProps(page, api, vault, 'wiki/p.md', '---\ntype: concept\nupdated: 2026-10-02\n---\n# p\n');
  const fmLines = async () => (await api.file(vault.id, 'wiki/p.md'))!.content.split('\n---\n')[0]!.split('\n');
  const missing = (k: string) => page.locator(`[data-testid="props-missing"][data-key="${k}"]`);
  await expect(missing('tags').getByTestId('props-violation')).toHaveText('required on wiki pages');

  await page.getByTestId('props-add').click();
  const key = page.getByTestId('props-add-key');
  const offered = await page.locator('#props-add-keys option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(offered).toEqual(expect.arrayContaining(['tags', 'confidence']));
  expect(offered).not.toContain('type');

  await key.fill('tags');
  await key.press('Enter');
  await expect.poll(async () => (await fmLines()).at(-1)).toBe('tags: []');
  await expect(missing('tags')).toHaveCount(0);
  await expect(row(page, 'tags').getByTestId('props-violation')).toHaveCount(0);

  await page.getByTestId('props-add').click();
  await key.fill('rating');
  await key.press('Enter');
  await expect.poll(async () => (await fmLines()).at(-1)).toBe('rating: ""');

  const before = (await api.file(vault.id, 'wiki/p.md'))!.content;
  await page.getByTestId('props-add').click();
  await key.fill('a: b');
  await key.press('Enter');
  await expect(page.getByTestId('toast')).toContainText('a: b');
  await page.waitForTimeout(500);
  expect((await api.file(vault.id, 'wiki/p.md'))!.content).toBe(before);
});
