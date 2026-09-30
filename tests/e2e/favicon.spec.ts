import { extensionTest, expect } from './extension';

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; message: string }> };
};

const ORIGIN = 'http://127.0.0.1:5177';
const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

const test = extensionTest([`${ORIGIN}/*`]);

test('a card gets the icon even when the declared one is on another host', async ({
  context,
  extensionId,
}) => {
  const article = await context.newPage();
  await article.goto(`${ORIGIN}/cdn-icon.html`);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);

  await article.bringToFront();
  const result = await list.evaluate((type) => chrome.runtime.sendMessage({ type }), SAVE_ACTIVE_TAB);
  expect(result, result.message).toMatchObject({ ok: true });

  await list.reload();
  const thumb = list.locator('.card__thumb');
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute('src', /^data:image\//);
});
