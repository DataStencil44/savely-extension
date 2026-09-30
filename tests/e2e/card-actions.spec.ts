import { expect, test } from './extension';

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; message: string }> };
};

const ORIGIN = 'http://127.0.0.1:5177';
const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

test('Enter on an action button runs that action, not the reader', async ({
  context,
  extensionId,
}) => {
  const article = await context.newPage();
  await article.goto(`${ORIGIN}/article.html`);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);
  await article.bringToFront();
  const saved = await list.evaluate((type) => chrome.runtime.sendMessage({ type }), SAVE_ACTIVE_TAB);
  expect(saved, saved.message).toMatchObject({ ok: true });

  await list.bringToFront();
  await list.reload();
  await expect(list.locator('.card')).toHaveCount(1);

  const pagesBefore = context.pages().length;

  await list.keyboard.press('ArrowDown');
  await list.locator('#item-favorite').focus();
  await list.keyboard.press('Enter');

  await expect(list.locator('#item-favorite')).toHaveAttribute('aria-pressed', 'true');
  expect(context.pages()).toHaveLength(pagesBefore);
});

test('a click selects a card for the toolbar, a double click opens the original', async ({
  context,
  extensionId,
}) => {
  const article = await context.newPage();
  await article.goto(`${ORIGIN}/article.html`);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);
  await article.bringToFront();
  const saved = await list.evaluate((type) => chrome.runtime.sendMessage({ type }), SAVE_ACTIVE_TAB);
  expect(saved, saved.message).toMatchObject({ ok: true });

  await list.bringToFront();
  await list.reload();
  await expect(list.locator('.card')).toHaveCount(1);
  await expect(list.locator('#item-archive')).toBeDisabled();

  await list.locator('.card__title').click();
  await expect(list.locator('.card')).toHaveAttribute('aria-selected', 'true');
  await expect(list.locator('#item-archive')).toBeEnabled();
  await expect(list.locator('#item-title')).toHaveText('A centre without cars');

  const [original] = await Promise.all([
    context.waitForEvent('page'),
    list.locator('.card__title').dblclick(),
  ]);
  await original.waitForLoadState('domcontentloaded');
  expect(original.url()).toBe(`${ORIGIN}/article.html`);
});

test('a deletion survives the popup closing right after it', async ({ context, extensionId }) => {
  const POPUP = `chrome-extension://${extensionId}/ui/list/list.html`;

  const article = await context.newPage();
  await article.goto(`${ORIGIN}/article.html`);

  const popup = await context.newPage();
  await popup.goto(POPUP);
  await article.bringToFront();
  const saved = await popup.evaluate((type) => chrome.runtime.sendMessage({ type }), SAVE_ACTIVE_TAB);
  expect(saved, saved.message).toMatchObject({ ok: true });

  await popup.bringToFront();
  await popup.reload();
  await expect(popup.locator('.card')).toHaveCount(1);

  await popup.locator('.card__title').click();
  await popup.locator('#item-delete').click();
  await expect(popup.locator('.card')).toHaveCount(0);
  await popup.goto('about:blank');

  const reopened = await context.newPage();
  await reopened.goto(POPUP);
  await expect(reopened.locator('#empty')).toBeVisible();
  await expect(reopened.locator('.card')).toHaveCount(0);
});
