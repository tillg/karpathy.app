import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openApp, openNote, pushFromObsidian, revealInTree, ROOT, test, treeItem, type Api, type TestVault } from './helpers';
import { FIRST_PARA, FIRST_PARA_WORDS, LONG, LONG_HEADINGS } from './fixtures/long-note';

// Note outline and note info (#79, note-outline-properties).

async function openLong(page: Page, api: Api, vault: TestVault) {
  await api.write(vault.id, 'Long.md', LONG);
  await openApp(page, vault.id);
  // Tablet: the sidebar is an overlay, hidden until toggled.
  if (await page.locator('#app.tablet').count()) await page.getByTestId('sidebar-toggle').click();
  await openNote(page, 'Long.md');
  if (await page.locator('#app.tablet.sbopen').count()) await page.getByTestId('sidebar-toggle').click();
}

const items = (page: Page) => page.getByTestId('outline-item');

/** Write mode shows the raw frontmatter lines (the properties form hides them by default). */
const yamlView = (page: Page) => page.getByTestId('props-yaml').click();

async function expectOutline(page: Page) {
  await expect(items(page)).toHaveText(LONG_HEADINGS.map((h) => h.text));
  expect(await items(page).evaluateAll((els) => els.map((e) => [Number(e.getAttribute('data-level')), Number(e.getAttribute('data-line'))])))
    .toEqual(LONG_HEADINGS.map((h) => [h.level, h.line]));
}

test('lists all headings with nesting, the same in Write and Read', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  await page.getByTestId('outline-button').click();
  await expect(page.getByTestId('outline')).toBeVisible();
  await expect(items(page)).toHaveCount(28); // 30 heading lines minus the fenced and the %% one
  await expectOutline(page);
  await expect(items(page).filter({ hasText: 'Section 12' })).toHaveCount(1); // inside the callout
  await expect(items(page).filter({ hasText: 'fake' })).toHaveCount(0);
  await expect(items(page).filter({ hasText: 'hidden' })).toHaveCount(0);

  await page.getByTestId('mode-read').click();
  await expect(page.getByTestId('read-view')).toBeVisible();
  if (!(await page.getByTestId('outline').isVisible())) await page.getByTestId('outline-button').click();
  await expectOutline(page);

  pushFromObsidian(vault.bare, 'raw/media/dot.png', readFileSync(join(ROOT, 'e2e/fixtures/media/dot.png')));
  await page.reload();
  await revealInTree(page, 'raw/media/dot.png');
  await treeItem(page, 'raw/media/dot.png').click();
  await expect(page.locator('.note-title')).toHaveText('dot.png');
  await expect(page.getByTestId('outline-button')).toHaveCount(0);
});

/** The editor's selection head (the view hangs off the content element). */
const head = (page: Page) => page.locator('.cm-content').evaluate((e) => (e as unknown as { cmTile: { view: { state: { selection: { main: { head: number } } } } } }).cmTile.view.state.selection.main.head);

/** Top of `el` relative to the pane's visible area (below the header), as a fraction of its height. */
async function topFraction(page: Page, el: import('@playwright/test').Locator) {
  const box = (await el.boundingBox())!;
  const sc = (await page.locator('#detail .scroll').boundingBox())!;
  return (box.y - (sc.y + 52)) / (sc.height - 52);
}

/** Within the top quarter of the pane (a few pixels above its top edge count: line padding). */
const atTop = async (page: Page, el: import('@playwright/test').Locator) => { const f = await topFraction(page, el); return f > -0.05 && f < 0.25; };

async function writeJump(page: Page, api: Api, vault: TestVault) {
  await openLong(page, api, vault);
  await page.locator('.cm-line').nth(1).click();
  const before = await head(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const hist = await page.evaluate(() => history.length);
  await page.getByTestId('outline-button').click();
  await items(page).filter({ hasText: /^Section 29$/ }).click();
  const line = page.locator('.cm-line', { hasText: /^#+ Section 29$/ });
  await expect.poll(() => atTop(page, line)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(false);
  expect(await head(page)).toBe(before);
  expect(await page.evaluate(() => history.length)).toBe(hist);
}

test('Write mode: tap scrolls the heading to the top, no focus', async ({ page, api, vault }) => {
  await writeJump(page, api, vault);
});

test('@iphone Write mode: tap scrolls the heading to the top, no focus', async ({ page, api, vault }) => {
  await writeJump(page, api, vault);
});

test('Read mode: tap scrolls the heading\'s block to the top and highlights it', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  await page.getByTestId('mode-read').click();
  await page.getByTestId('outline-button').click();
  const h29 = LONG_HEADINGS.find((h) => h.text === 'Section 29')!;
  await items(page).filter({ hasText: /^Section 29$/ }).click();
  const block = page.locator(`.rd > [data-line="${h29.line}"]`);
  await expect.poll(() => atTop(page, block)).toBe(true);
  await expect(block).toHaveClass(/\bhit\b/);
  await page.waitForTimeout(2000);
  await expect(block).not.toHaveClass(/\bhit\b/);

  // A heading inside a callout lands on the callout.
  const h12 = LONG_HEADINGS.find((h) => h.text === 'Section 12')!;
  if (!(await page.getByTestId('outline').isVisible())) await page.getByTestId('outline-button').click();
  await items(page).filter({ hasText: /^Section 12$/ }).click();
  const callout = page.locator(`.rd > [data-line="${h12.line - 1}"]`);
  await expect.poll(() => atTop(page, callout)).toBe(true);
});

/** Scrolls the note pane by hand (no outline jump) until the element `sel` whose text matches `re` sits at the top. */
const scrollUntilTop = (page: Page, sel: string, re: string) => page.locator('#detail .scroll').evaluate(async (sc, [sel, re]) => {
  const rx = new RegExp(re!);
  const top = () => sc.getBoundingClientRect().top + parseFloat(getComputedStyle(sc).paddingTop);
  for (let i = 0; i < 400; i++) {
    const el = [...sc.querySelectorAll(sel!)].find((e) => rx.test(e.textContent ?? ''));
    // A few pixels above the top edge, so the heading is the first visible line.
    const d = el ? el.getBoundingClientRect().top - top() + 5 : 200;
    if (el && Math.abs(d) < 2) return true;
    sc.scrollTop += d;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return false;
}, [sel, re]);

test('current section follows the scroll', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  await page.getByTestId('outline-button').click();
  const current = page.locator('[data-testid="outline-item"][aria-current="location"]');
  for (const [mode, sel] of [['write', '.cm-line'], ['read', '.rd > [data-line]']] as const) {
    await page.getByTestId(`mode-${mode}`).click();
    expect(await scrollUntilTop(page, sel, '^#* ?Section 20$')).toBe(true);
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText('Section 20');
    await page.locator('#detail .scroll').evaluate((sc) => { sc.scrollTop = 0; });
    await expect(current).toHaveCount(0);
  }
});

test('@iphone bottom sheet', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  const outline = page.getByTestId('outline');
  await page.getByTestId('outline-button').click();
  await expect(outline).toHaveAttribute('aria-modal', 'true');
  const tabs = (await page.locator('#tabbar').boundingBox())!;
  await expect.poll(async () => { const b = (await outline.boundingBox())!; return Math.abs(b.y + b.height - tabs.y); }).toBeLessThan(2);
  await items(page).filter({ hasText: /^Section 20$/ }).click();
  await expect(outline).toHaveCount(0);
  await page.getByTestId('outline-button').click();
  await page.getByTestId('outline-scrim').click({ position: { x: 20, y: 80 } });
  await expect(outline).toHaveCount(0);
  await page.getByTestId('outline-button').click();
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
});

test('@ipad panel', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  const outline = page.getByTestId('outline');
  await page.getByTestId('outline-button').click();
  await expect(outline).toHaveAttribute('aria-modal', 'false');
  const box = (await outline.boundingBox())!;
  const pane = (await page.locator('#detail').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(pane.x);
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
  await items(page).filter({ hasText: /^Section 20$/ }).click();
  await expect(outline).toHaveCount(0);
  await page.getByTestId('outline-button').click();
  await expect(outline).toBeVisible();
  await page.locator('#detail .scroll').click({ position: { x: 40, y: 400 } }); // a tap in the note, outside the panel
  await expect(outline).toHaveCount(0);
  await page.getByTestId('outline-button').click();
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
});

test('wide panel', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  const outline = page.getByTestId('outline');
  await page.getByTestId('outline-button').click();
  await items(page).filter({ hasText: /^Section 20$/ }).click();
  await expect(outline).toBeVisible();
  await openNote(page, 'Home.md');
  await expect(outline).toBeVisible();
  await page.getByTestId('outline-button').click();
  await expect(outline).toHaveCount(0);

  // Sidebar and chat open at 1024 px: the note column is narrow, the panel still fits inside it.
  await page.setViewportSize({ width: 1024, height: 800 });
  if (!(await page.getByTestId('chat-toggle').getAttribute('class'))?.includes(' on')) await page.getByTestId('chat-toggle').click();
  await page.getByTestId('outline-button').click();
  const box = (await outline.boundingBox())!;
  const pane = (await page.locator('#detail').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(pane.x);
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width);
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
});

test('note info excludes the frontmatter', async ({ page, api, vault }) => {
  await openLong(page, api, vault);
  await yamlView(page);
  await page.getByTestId('outline-button').click();
  const info = page.getByTestId('note-info');
  await expect(info).toContainText('2,200 words');
  await expect(info).toContainText('~10 min read');
  await page.getByTestId('mode-read').click();
  await expect(info).toContainText('2,200 words');
  await expect(info).toContainText('~10 min read');

  await page.getByTestId('mode-write').click();
  await page.locator('.cm-line', { hasText: 'type: synthesis' }).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' extra');
  await expect(info).toContainText('2,200 words');
  await page.locator('.cm-line', { hasText: FIRST_PARA }).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('End');
  await page.keyboard.type(' extra');
  await expect(info).toContainText('2,201 words');
});

/** Selects the contents of `sel` in the rendered note (DOM selection, like a long-press or triple-click). */
const selectRendered = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(r);
});

async function selectionAware(page: Page, api: Api, vault: TestVault, phone: boolean) {
  await openLong(page, api, vault);
  await yamlView(page);
  const info = page.getByTestId('note-info');
  const open = async () => { if (!(await page.getByTestId('outline').count())) await page.getByTestId('outline-button').click(); };
  const close = async () => { if (await page.getByTestId('outline').count()) await page.keyboard.press('Escape'); };

  // Write mode: from the middle of the frontmatter to the end of the first paragraph; only the body part counts.
  await page.locator('.cm-line', { hasText: 'type: synthesis' }).click({ position: { x: 5, y: 5 } });
  // By document positions: Shift+End stops at a wrapped line's visual end on the phone.
  await page.locator('.cm-content').evaluate((e, para) => {
    const view = (e as unknown as { cmTile: { view: { state: { doc: { line(n: number): { from: number; to: number; text: string }; lines: number } }; dispatch(t: unknown): void } } }).cmTile.view;
    const doc = view.state.doc;
    let end = 0;
    for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text === para) { end = doc.line(n).to; break; }
    view.dispatch({ selection: { anchor: doc.line(4).from + 3, head: end } });
  }, FIRST_PARA);
  await open();
  await expect(info).toHaveText(`Selection: ${FIRST_PARA_WORDS} words · ${FIRST_PARA.length} characters`);
  await close();

  // Read mode: a paragraph of the note counts; a value in the properties table doesn't; no selection = the note.
  await page.getByTestId('mode-read').click();
  await selectRendered(page, `.rd p:text-is("${FIRST_PARA}")`);
  await open();
  await expect(info).toHaveText(`Selection: ${FIRST_PARA_WORDS} words · ${FIRST_PARA.length} characters`);
  if (phone) return;
  await selectRendered(page, '.read .props .pv');
  await expect(info).toContainText('2,200 words');
  await selectRendered(page, `.rd p:text-is("${FIRST_PARA}")`);
  await expect(info).toContainText('Selection:');
  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(info).toContainText('2,200 words');
}

test('selection-aware', async ({ page, api, vault }) => {
  await selectionAware(page, api, vault, false);
});

test('@iphone selection-aware: the selection is read before the tap', async ({ page, api, vault }) => {
  await selectionAware(page, api, vault, true);
});

test('typing in a long note with the outline open stays fast', async ({ page, api, vault }) => {
  test.setTimeout(240_000);
  const sections = Array.from({ length: 5000 }, (_, i) => `## Heading ${i + 1}\n\n${'word '.repeat(20).trim()}\n`);
  await api.write(vault.id, 'Huge.md', `# Huge\n\n${sections.join('\n')}`);
  await openApp(page, vault.id);
  await openNote(page, 'Huge.md');
  await page.getByTestId('outline-button').click();
  const info = page.getByTestId('note-info');
  await expect(info).toContainText('words');
  const before = await info.textContent();
  // The outline and the note info walk the whole note (a 100–200 ms freeze here): never while typing.
  await info.evaluate((el) => {
    const w = window as unknown as { infoChanges: number };
    w.infoChanges = 0;
    new MutationObserver(() => { w.infoChanges++; }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' typing eighty characters to check that the outline never freezes the editor', { delay: 40 });
  expect(await page.evaluate(() => (window as unknown as { infoChanges: number }).infoChanges)).toBe(0);
  // After a pause they follow the text.
  await expect(info).not.toHaveText(before!);
  await page.keyboard.type('\n\n## Zebra');
  await expect(page.getByTestId('outline-item').last()).toHaveText('Zebra');
});
