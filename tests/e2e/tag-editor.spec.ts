/**
 * The tag editor under real presses - jsdom cannot produce them.
 *
 * A real press is a mousedown before the click, which the editor's
 * outside-click handler sees first; and a double click carries `detail: 2` on
 * its second click. Both facts only show up in a real browser, and both used
 * to leave something on screen the user never asked for.
 */
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

  // No `?full=1`: this is the popup, the way the toolbar opens it.
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

  // The press that closes the panel arrives as a mousedown first - the panel
  // must not treat it as an outside click and reopen on the click that follows.
  await tags.click();
  await expect(editor).toBeHidden();

  // A double click is one press: the panel opens and stays open, and nothing
  // else happens - the toolbar is not a card, so no original opens either.
  const pages = context.pages().length;
  await tags.dblclick();
  await list.waitForTimeout(300);
  await expect(editor).toBeVisible();
  expect(context.pages()).toHaveLength(pages);
  expect(list.isClosed()).toBe(false);
});
