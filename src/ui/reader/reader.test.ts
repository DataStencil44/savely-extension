// @vitest-environment jsdom
/**
 * Test czytnika na jsdom: montujemy prawdziwy `index.html`, uruchamiamy
 * `reader.ts` i sprawdzamy to, czego nie widać w testach jednostkowych -
 * że treść trafia do DOM-u po sanityzacji, podświetlenia się odtwarzają,
 * a ustawienia z `storage.sync` faktycznie zmieniają wygląd.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import html from './index.html?raw';

const settingsStore = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const noop = (): void => undefined;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: 'test',
        getURL: (path: string) => `chrome-extension://test/${path}`,
        lastError: null,
      },
      storage: {
        sync: {
          get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            callback(key !== undefined && key in data ? { [key]: data[key] } : {});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(data, items);
            callback();
          },
        },
        local: {
          get: (_keys: unknown, callback: (items: unknown) => void) => {
            callback({});
          },
        },
        onChanged: { addListener: noop },
      },
      tabs: {
        create: noop,
        getCurrent: (callback: (tab: unknown) => void) => {
          callback(undefined);
        },
        remove: noop,
      },
    },
  });

  return data;
});

const { addHighlight, deleteDb, getItem, saveItem, setContent } = await import('@/lib/db');

const ARTICLE = [
  '<p>Rada miasta przyjela uchwale o zmianie organizacji ruchu w centrum.</p>',
  '<figure><img src="https://cdn.example/ulica.jpg" alt="Ulica"><figcaption>Ulica po przebudowie</figcaption></figure>',
  '<h2>Co sie zmieni</h2>',
  '<p>Chodniki zostana poszerzone kosztem miejsc parkingowych wzdluz jezdni.</p>',
].join('');

let itemId = '';

/** Wysokość dokumentu i okna udajemy sami - jsdom nie liczy układu. */
const PAGE_HEIGHT = 2_000;
const VIEWPORT = 800;
let scrollTop = 0;

/** Przewija stronę do zadanej części treści i czeka na obsługę zdarzenia. */
async function scrollToRatio(ratio: number): Promise<void> {
  document.documentElement.scrollTop = ratio * (PAGE_HEIGHT - VIEWPORT);
  window.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeAll(async () => {
  await deleteDb();

  settingsStore['reader-settings'] = { theme: 'sepia', fontFamily: 'dyslexia', fontSize: 22 };

  const item = await saveItem({
    url: 'https://gazeta.example/artykul',
    title: 'Centrum bez samochodow',
    byline: 'Anna Kowalska',
    wordCount: 400,
    savedAt: 1_700_000_000_000,
  });
  itemId = item.id;

  await setContent(item.id, { html: ARTICLE, text: 'nieistotne dla testu' });

  // Podświetlenie zapisane wcześniej - offsety liczone z tekstu artykułu.
  await addHighlight({
    itemId: item.id,
    text: 'organizacji ruchu',
    start: 45,
    end: 62,
    prefix: 'uchwale o zmianie ',
    suffix: ' w centrum.',
  });

  const root = document.documentElement;
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => PAGE_HEIGHT });
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(root, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });

  window.history.replaceState({}, '', `/ui/reader/index.html?id=${itemId}`);

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const script of parsed.querySelectorAll('script')) script.remove();
  document.body.replaceChildren(...parsed.body.childNodes);

  await import('./reader');
  await new Promise((resolve) => setTimeout(resolve, 200));
});

describe('czytnik', () => {
  it('pokazuje nagłówek z metadanymi', () => {
    expect(document.querySelector('.title')?.textContent).toBe('Centrum bez samochodow');
    expect(document.querySelector('.meta')?.textContent).toContain('Anna Kowalska');
    expect(document.querySelector('.meta')?.textContent).toContain('gazeta.example');
  });

  it('wstawia treść po sanityzacji, z podpisem pod figure', () => {
    const content = document.querySelector('.content');
    expect(content?.querySelectorAll('p')).toHaveLength(2);
    expect(content?.querySelector('h2')?.textContent).toBe('Co sie zmieni');
    expect(content?.querySelector('figcaption')?.textContent).toBe('Ulica po przebudowie');
    expect(content?.querySelector('script')).toBeNull();
  });

  it('odtwarza zapisane podświetlenie z offsetów tekstowych', () => {
    const mark = document.querySelector('mark[data-highlight]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('organizacji ruchu');
  });

  it('stosuje ustawienia z storage.sync', () => {
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('sepia');
    expect(root.dataset['family']).toBe('dyslexia');
    expect(root.style.getPropertyValue('--font-size')).toBe('22px');
    expect(root.style.getPropertyValue('--column-width')).toBe('68ch');
  });

  it('zmiana rozmiaru zapisuje się i od razu działa', async () => {
    document.querySelector<HTMLButtonElement>('[data-font-size="1"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('23px');
    expect(settingsStore['reader-settings']).toMatchObject({ fontSize: 23 });
  });

  it('wyłączenie obrazków zdalnych zdejmuje src i daje się cofnąć', async () => {
    const image = document.querySelector<HTMLImageElement>('.content img');
    expect(image?.getAttribute('src')).toBe('https://cdn.example/ulica.jpg');

    const checkbox = document.querySelector<HTMLInputElement>('#remote-images');
    if (checkbox === null) throw new Error('brak przełącznika obrazków');

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(image?.getAttribute('src')).toBeNull();
    expect(image?.classList.contains('blocked')).toBe(true);
    expect(settingsStore['reader-settings']).toMatchObject({ remoteImages: false });

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(image?.getAttribute('src')).toBe('https://cdn.example/ulica.jpg');
  });

  it('oznacza jako przeczytane dopiero po dotarciu do 90% treści', async () => {
    await scrollToRatio(0.5);
    expect(document.querySelector<HTMLElement>('#progress-bar')?.style.width).toBe('50%');
    expect((await getItem(itemId))?.readAt).toBeNull();

    await scrollToRatio(0.95);
    expect(document.querySelector<HTMLElement>('#progress-bar')?.style.width).toBe('95%');
    expect((await getItem(itemId))?.readAt).not.toBeNull();
  });

  it('skrót f przełącza ulubione', async () => {
    const favorite = document.querySelector<HTMLButtonElement>('#favorite');
    expect(favorite?.getAttribute('aria-pressed')).toBe('false');

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'f' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(favorite?.getAttribute('aria-pressed')).toBe('true');
  });
});
