import type { Page } from '@playwright/test';
import { expect, openApp, openNote, test, typeAtEnd } from './helpers';

// Main pane (specs/changes/chat-main): the swap button on the note/chat divider puts the chat in the
// main column and the note in the 380 px side column. Desktop is 1280 × 800, so the chat starts open.

const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

test('swap button sits on the note/chat divider', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const swap = page.getByTestId('main-swap');
  await expect(swap).toBeVisible();
  await expect(swap).toHaveAttribute('aria-pressed', 'false');
  await expect(swap).toHaveAccessibleName('Move chat to main column');
  const b = await box(page, '[data-testid="main-swap"]');
  const chat = await box(page, '#chat');
  expect(Math.abs(b.x + b.width / 2 - chat.x)).toBeLessThanOrEqual(2);
  expect(b.y).toBeGreaterThanOrEqual(chat.y);
  expect(b.y + b.height).toBeLessThanOrEqual(chat.y + 52);
});

/** True when the points 2 px inside the left edge, at the centre and 2 px inside the right edge of
 *  `sel`'s box all hit that element (or something inside it), i.e. nothing covers any part of it. */
const hitsSelf = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return [r.left + 2, r.left + r.width / 2, r.right - 2].every((x) => {
    const hit = document.elementFromPoint(x, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
});

test('bar buttons next to the divider stay clickable', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  await page.getByTestId('new-chat').click();
  await expect(page.getByTestId('chat-back')).toBeVisible();
  expect(await hitsSelf(page, '[data-testid="chat-toggle"]')).toBe(true);
  expect(await hitsSelf(page, '[data-testid="chat-back"]')).toBe(true);
});

test('no swap button while the chat is closed', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await expect(page.getByTestId('main-swap')).toBeVisible();
  await page.getByTestId('chat-toggle').click();
  await expect(page.locator('#chat')).toBeHidden();
  await expect(page.getByTestId('main-swap')).toHaveCount(0);
});

test('@ipad no swap button: the chat is an overlay', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await page.getByTestId('chat-toggle').click();
  await expect(page.locator('#app')).toHaveClass(/insp/);
  await expect(page.getByTestId('new-chat')).toBeVisible();
  await expect(page.getByTestId('main-swap')).toHaveCount(0);
});

test('@iphone no swap button: the chat is a tab', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await page.getByTestId('tab-chat').click();
  await expect(page.getByTestId('new-chat')).toBeVisible();
  await expect(page.getByTestId('main-swap')).toHaveCount(0);
});

test('swap puts the chat in the main column and back', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await openNote(page, 'Home.md');
  const swap = page.getByTestId('main-swap');
  const before = { detail: await box(page, '#detail'), chat: await box(page, '#chat') };

  await swap.click();
  await expect(swap).toHaveAttribute('aria-pressed', 'true');
  await expect(swap).toHaveAccessibleName('Move note to main column');
  const detail = await box(page, '#detail');
  const chat = await box(page, '#chat');
  expect(chat.x).toBeLessThan(detail.x);
  expect(chat.width).toBeGreaterThan(detail.width);
  expect(Math.abs(detail.width - 380)).toBeLessThanOrEqual(1);
  const b = await box(page, '[data-testid="main-swap"]');
  expect(Math.abs(b.x + b.width / 2 - detail.x)).toBeLessThanOrEqual(2);
  // The bar buttons now next to the divider: the chat's close ✕ and the note's sidebar toggle.
  expect(await hitsSelf(page, '#chat > .bar button[title="Close chat"]')).toBe(true);
  expect(await hitsSelf(page, '[data-testid="sidebar-toggle"]')).toBe(true);

  await swap.click();
  await expect(swap).toHaveAttribute('aria-pressed', 'false');
  expect(await box(page, '#detail')).toEqual(before.detail);
  expect(await box(page, '#chat')).toEqual(before.chat);
});

test('swap keeps the editor and the chat composer alive', async ({ page, vault, api }) => {
  const long = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a long note, long enough to wrap in the side column.`).join('\n\n');
  await api.write(vault.id, 'Long.md', `# Long\n\n${long}\n`);
  await openApp(page, vault.id);
  await openNote(page, 'Long.md');
  await typeAtEnd(page, ' typed-in-editor');
  await page.getByTestId('new-chat').click();
  // A chat that loads after the scroll below would put the list at its end.
  await expect(page.getByTestId('chat-messages')).toContainText('New chat');
  const composer = page.getByTestId('chat-composer');
  await composer.fill('typed in the composer');
  // Give the message list something to scroll (a new chat has no messages; a model turn would be slow).
  await page.locator('#chat [role="region"][aria-label="Messages"]').evaluate((el) => {
    const pad = document.createElement('div');
    pad.style.height = '3000px';
    el.append(pad);
  });
  const scrollers = ['#detail .scroll', '#chat [role="region"][aria-label="Messages"]'];
  for (const sel of scrollers) await page.locator(sel).evaluate((el) => { el.scrollTop = 600; });
  const tops = async () => Promise.all(scrollers.map((sel) => page.locator(sel).evaluate((el) => el.scrollTop)));
  const before = await tops();
  expect(before.every((t) => t > 0)).toBe(true);
  for (const sel of ['.cm-editor', '[data-testid="chat-composer"]'])
    await page.locator(sel).evaluate((el) => { (el as unknown as { __mark: number }).__mark = 1; });
  await composer.focus();

  // el.click(): a real mouse click would move focus to the button.
  const swap = page.getByTestId('main-swap');
  await swap.evaluate((el: HTMLElement) => el.click());
  await expect(swap).toHaveAttribute('aria-pressed', 'true');
  await swap.evaluate((el: HTMLElement) => el.click());
  await expect(swap).toHaveAttribute('aria-pressed', 'false');

  for (const sel of ['.cm-editor', '[data-testid="chat-composer"]'])
    expect(await page.locator(sel).evaluate((el) => (el as unknown as { __mark?: number }).__mark), sel).toBe(1);
  await expect(page.locator('.cm-content')).toContainText('typed-in-editor');
  await expect(composer).toHaveValue('typed in the composer');
  const after = await tops();
  after.forEach((t, i) => expect(Math.abs(t - before[i]), scrollers[i]).toBeLessThanOrEqual(1));
  expect(await composer.evaluate((el) => el === document.activeElement)).toBe(true);
});

// iPad Pro 13" gets the wide layout in both orientations, so the swap must work by touch (44 px target).
for (const [name, viewport] of [['landscape', { width: 1376, height: 1032 }], ['portrait', { width: 1032, height: 1376 }]] as const) {
  test.describe(`iPad Pro 13" ${name}`, () => {
    test.use({ viewport });
    test(`@ipad iPad Pro 13" ${name}: tap swaps the columns`, async ({ page, vault }) => {
      await openApp(page, vault.id);
      await expect(page.locator('#app')).toHaveClass(/\bwide\b/);
      if (!(await page.locator('#app').getAttribute('class'))!.includes('insp')) await page.getByTestId('chat-toggle').tap();
      const swap = page.getByTestId('main-swap');
      const b = await box(page, '[data-testid="main-swap"]');
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
      await swap.tap();
      await expect(swap).toHaveAttribute('aria-pressed', 'true');
      const detail = await box(page, '#detail');
      const chat = await box(page, '#chat');
      expect(chat.x).toBeLessThan(detail.x);
      expect(Math.abs(detail.width - 380)).toBeLessThanOrEqual(1);
      // Portrait with the sidebar open: main is 1032 − 280 − 380 = 372 px, the accepted limitation.
      if (name === 'landscape') expect(chat.width).toBeGreaterThan(detail.width);
    });
  });
}

test('chat in main survives a reload', async ({ page, vault }) => {
  await openApp(page, vault.id);
  const swap = page.getByTestId('main-swap');
  await swap.click();
  await expect(page.locator('#app')).toHaveClass(/\bchatmain\b/);
  await page.reload();
  await expect(swap).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#app')).toHaveClass(/\bchatmain\b/);
  expect((await box(page, '#chat')).x).toBeLessThan((await box(page, '#detail')).x);

  await swap.click();
  await page.reload();
  await expect(swap).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#app')).not.toHaveClass(/\bchatmain\b/);
  expect((await box(page, '#detail')).x).toBeLessThan((await box(page, '#chat')).x);
});

test('closing the chat while it is in main, then reopening it, puts it back in main', async ({ page, vault }) => {
  await openApp(page, vault.id);
  await page.getByTestId('main-swap').click();
  await page.locator('#chat > .bar button[title="Close chat"]').click();
  await expect(page.locator('#chat')).toBeHidden();
  const sidebar = await box(page, '#sidebar');
  const detail = await box(page, '#detail');
  expect(Math.abs(detail.x - (sidebar.x + sidebar.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(detail.x + detail.width - page.viewportSize()!.width)).toBeLessThanOrEqual(1);

  await page.getByTestId('chat-toggle').click();
  await expect(page.getByTestId('main-swap')).toHaveAttribute('aria-pressed', 'true');
  const chat = await box(page, '#chat');
  expect(chat.x).toBeLessThan((await box(page, '#detail')).x);
  expect(chat.width).toBeGreaterThan(380);
});
