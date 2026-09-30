import { expect, test } from './extension';

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; message: string }> };
};

const FIXTURE = 'http://127.0.0.1:5177/article.html';
const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

test('a saved page lands in the list and opens in the reader', async ({ context, extensionId }) => {
  const article = await context.newPage();
  await article.goto(FIXTURE);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);
  await expect(list.locator('#empty')).toHaveText('Nothing here yet. Save your first page.');

  await article.bringToFront();
  const result = await list.evaluate(
    (type) => chrome.runtime.sendMessage({ type }),
    SAVE_ACTIVE_TAB,
  );
  expect(result, result.message).toMatchObject({ ok: true });

  await list.reload();
  await expect(list.locator('.card__title')).toHaveText('A centre without cars');
  await expect(list.locator('.card__meta')).toContainText('127.0.0.1');

  await list.locator('.card__title').click();
  const [reader] = await Promise.all([
    context.waitForEvent('page'),
    list.locator('#item-read').click(),
  ]);
  await reader.waitForLoadState('domcontentloaded');

  await expect(reader.locator('.title')).toHaveText('A centre without cars');
  await expect(reader.locator('.content')).toContainText('The city council adopted a resolution');
  await expect(reader.locator('.content h2')).toHaveText('What will change');
  await expect(reader.locator('.content figcaption')).toHaveText('Long Street after the rebuild');

  await expect(reader.locator('.content')).not.toContainText('The site footer');

  await expect(reader.locator('.content script')).toHaveCount(0);
  await expect(reader.locator('.content a[href^="javascript:"]')).toHaveCount(0);
  await expect(reader.locator('.content [onerror]')).toHaveCount(0);
  expect(await reader.evaluate(() => (window as { __savelyXss?: string }).__savelyXss)).toBeUndefined();

  await reader.keyboard.press('f');
  await expect(reader.locator('#favorite')).toHaveAttribute('aria-pressed', 'true');
});

test('re-saving the same address does not duplicate the item', async ({ context, extensionId }) => {
  const article = await context.newPage();
  await article.goto(FIXTURE);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);

  for (const _ of [1, 2]) {
    await article.bringToFront();
    const result = await list.evaluate(
      (type) => chrome.runtime.sendMessage({ type }),
      SAVE_ACTIVE_TAB,
    );
    expect(result, result.message).toMatchObject({ ok: true });
  }

  await list.reload();
  await expect(list.locator('.card')).toHaveCount(1);
});
