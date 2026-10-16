import { expect, openApp, openNote, test } from './helpers';

// #160: in the side-column chat the "‹ Chats" back link and the centred model name ran together ("ChatsQwen3…").
for (const width of [1280, 1440]) {
  test(`160 the chat's back link and model name keep a gap at ${width} px`, async ({ page, vault }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page, vault.id);
    await openNote(page, 'Home.md');
    await page.getByTestId('new-chat').click();
    const back = page.getByTestId('chat-back');
    const model = page.locator('#chat .ctitle .model');
    await expect(back).toBeVisible();
    await expect(model).not.toBeEmpty();
    const b = (await back.boundingBox())!;
    const m = (await model.boundingBox())!;
    expect(m.x - (b.x + b.width)).toBeGreaterThanOrEqual(8);
  });
}
