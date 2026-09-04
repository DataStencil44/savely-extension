/**
 * Sciezka, ktorej nie da sie sprawdzic w jsdom: prawdziwe Chromium, prawdziwe
 * rozszerzenie, prawdziwa strona.
 *
 * Zapis -> lista -> czytnik przechodzi przez wszystkie warstwy naraz: content
 * script wstrzykiwany przez `scripting.executeScript`, Readability na zywym
 * DOM-ie, DOMPurify, IndexedDB, wirtualizowana lista i widok czytnika.
 */
import { expect, test } from './extension';

/**
 * `chrome.*` w `page.evaluate` leci w kontekscie STRONY rozszerzenia, gdzie nie
 * ma naszego polyfilla - to jedyne miejsce w repo, gdzie tak ma byc.
 */
declare const chrome: {
  runtime: { sendMessage: (message: unknown) => Promise<{ ok: boolean; message: string }> };
};

const FIXTURE = 'http://127.0.0.1:5177/artykul.html';
const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

test('zapis strony trafia na liste i otwiera sie w czytniku', async ({ context, extensionId }) => {
  const article = await context.newPage();
  await article.goto(FIXTURE);

  const list = await context.newPage();
  await list.goto(`chrome-extension://${extensionId}/ui/list/list.html?full=1`);
  await expect(list.locator('#empty')).toHaveText('Nic tu jeszcze nie ma. Zapisz pierwszą stronę.');

  // Tlo zapisuje AKTYWNA karte, wiec fixture musi byc na wierzchu. Wiadomosc
  // idzie ze strony rozszerzenia dokladnie tak, jak z popupu.
  await article.bringToFront();
  const result = await list.evaluate(
    (type) => chrome.runtime.sendMessage({ type }),
    SAVE_ACTIVE_TAB,
  );
  expect(result, result.message).toMatchObject({ ok: true });

  await list.reload();
  await expect(list.locator('.card__title')).toHaveText('Centrum bez samochodów');
  await expect(list.locator('.card__meta')).toContainText('127.0.0.1');

  // Czytnik otwiera sie w nowej karcie.
  const [reader] = await Promise.all([
    context.waitForEvent('page'),
    list.locator('.card__actions .icon').first().click(),
  ]);
  await reader.waitForLoadState('domcontentloaded');

  await expect(reader.locator('.title')).toHaveText('Centrum bez samochodów');
  await expect(reader.locator('.content')).toContainText('Rada miasta przyjęła wczoraj uchwałę');
  await expect(reader.locator('.content h2')).toHaveText('Co się zmieni');
  await expect(reader.locator('.content figcaption')).toHaveText('Ulica Długa po przebudowie');

  // Nawigacja i stopka to nie tresc artykulu.
  await expect(reader.locator('.content')).not.toContainText('Stopka serwisu');

  // Ladunki z fixture'a nie przezyly sanityzacji.
  await expect(reader.locator('.content script')).toHaveCount(0);
  await expect(reader.locator('.content a[href^="javascript:"]')).toHaveCount(0);
  await expect(reader.locator('.content [onerror]')).toHaveCount(0);
  expect(await reader.evaluate(() => (window as { __savelyXss?: string }).__savelyXss)).toBeUndefined();

  // Pasek postepu i skroty dzialaja na prawdziwym ukladzie strony.
  await reader.keyboard.press('f');
  await expect(reader.locator('#favorite')).toHaveAttribute('aria-pressed', 'true');
});

test('ponowny zapis tego samego adresu nie dubluje pozycji', async ({ context, extensionId }) => {
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
