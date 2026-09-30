import { expect, test } from './extension';

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; message: string }> };
};

const FIXTURE = 'http://127.0.0.1:5177/article.html';
const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

test('the tags button opens the editor, closes it again, and takes a double click as one press', async ({
  context,
  extensionId,
}) => {
  const article = await context.newPage();
  await article.goto(FIXTURE);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html`);

  await article.bringToFront();
  const saved = await list.evaluate((type) => chrome.runtime.sendMessage({ type }), SAVE_ACTIVE_TAB);
  expect(saved, saved.message).toMatchObject({ ok: true });

  await list.reload();
  await expect(list.locator('.card__title')).toHaveText('A centre without cars');

  const tags = list.locator('#item-tags');
  const editor = list.locator('#tag-editor');

  await list.locator('.card__title').click();
  await tags.click();
  await expect(editor).toBeVisible();

  await tags.click();
  await expect(editor).toBeHidden();

  const pages = context.pages().length;
  await tags.dblclick();
  await list.waitForTimeout(300);
  await expect(editor).toBeVisible();
  expect(context.pages()).toHaveLength(pages);
  expect(list.isClosed()).toBe(false);
});
