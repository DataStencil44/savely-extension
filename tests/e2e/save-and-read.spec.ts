/**
 * The path jsdom cannot check: real Chromium, a real extension, a real page.
 *
 * Save -> list -> reader goes through every layer at once: the content script
 * injected by `scripting.executeScript`, Readability on a live DOM, DOMPurify,
 * IndexedDB, the virtualized list and the reader view.
 */
import { expect, test } from './extension';

/**
 * `chrome.*` inside `page.evaluate` runs in the context of the extension PAGE,
 * where our polyfill is absent - the only place in the repo where that is
 * intended.
 */
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

  // The background saves the ACTIVE tab, so the fixture has to be on top. The
  // message goes from an extension page exactly as it would from the popup.
  await article.bringToFront();
  const result = await list.evaluate(
    (type) => chrome.runtime.sendMessage({ type }),
    SAVE_ACTIVE_TAB,
  );
  expect(result, result.message).toMatchObject({ ok: true });

  await list.reload();
  await expect(list.locator('.card__title')).toHaveText('A centre without cars');
  await expect(list.locator('.card__meta')).toContainText('127.0.0.1');

  // The reader opens in a new tab. The button is picked by its label, not by
  // its position: the first icon on the card is "Open original".
  const [reader] = await Promise.all([
    context.waitForEvent('page'),
    list.locator('.card__actions [aria-label^="Read"]').first().click(),
  ]);
  await reader.waitForLoadState('domcontentloaded');

  await expect(reader.locator('.title')).toHaveText('A centre without cars');
  await expect(reader.locator('.content')).toContainText('The city council adopted a resolution');
  await expect(reader.locator('.content h2')).toHaveText('What will change');
  await expect(reader.locator('.content figcaption')).toHaveText('Long Street after the rebuild');

  // The navigation and the footer are not article content.
  await expect(reader.locator('.content')).not.toContainText('The site footer');

  // The fixture's payloads did not survive sanitization.
  await expect(reader.locator('.content script')).toHaveCount(0);
  await expect(reader.locator('.content a[href^="javascript:"]')).toHaveCount(0);
  await expect(reader.locator('.content [onerror]')).toHaveCount(0);
  expect(await reader.evaluate(() => (window as { __savelyXss?: string }).__savelyXss)).toBeUndefined();

  // The progress bar and the shortcuts work on a real page layout.
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
