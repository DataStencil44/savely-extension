/**
 * The theme is one setting for every extension page, so the thing worth
 * checking in a real browser is the part jsdom cannot show: a switch on one
 * page reaching another page that is already open, through `storage.onChanged`.
 */
import { expect, test } from './extension';

test('a theme picked on the options page reaches an open list without a reload', async ({
  context,
  extensionId,
}) => {
  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);
  await expect.poll(() => list.evaluate(() => document.documentElement.dataset['theme'])).toBe('light');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/ui/options/options.html`);
  await options.locator('[data-theme-choice="sepia"]').click();

  await expect.poll(() => list.evaluate(() => document.documentElement.dataset['theme'])).toBe('sepia');
  await expect(list.locator('#theme')).toHaveAttribute('title', /Theme: Sepia/);
});
