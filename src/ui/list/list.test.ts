// @vitest-environment jsdom
/**
 * Test widoku listy na jsdom: montujemy prawdziwy `list.html`, uruchamiamy
 * `list.ts` i klikamy jak użytkownik.
 *
 * Sprawdzamy przede wszystkim to, czego nie widać w testach jednostkowych:
 * że wirtualizacja trzyma w DOM-ie kilkanaście kart niezależnie od długości
 * listy, oraz że popup i pełna strona różnią się dokładnie tym, czym mają.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import html from './list.html?raw';
import { deleteDb, getItem, saveItem, setContent } from '@/lib/db';

const ITEMS = 300;

/** Adresy przekazane do `tabs.create` - stad wiemy, co poszlo do nowej karty. */
const openedTabs: string[] = [];

/**
 * Markup strony bez `<script>` - moduł ładujemy sami, po przygotowaniu DOM-u.
 * Składamy go przez DOMParser, a nie `innerHTML`: ta sama zasada obowiązuje
 * w testach, co w kodzie (CLAUDE.md 3).
 */
function mount(search: string): void {
  window.history.replaceState({}, '', `/ui/list/list.html${search}`);

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const script of parsed.querySelectorAll('script')) script.remove();
  document.body.replaceChildren(...parsed.body.childNodes);
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cards(): NodeListOf<HTMLLIElement> {
  return document.querySelectorAll<HTMLLIElement>('.card');
}

beforeAll(async () => {
  await deleteDb();

  // webextension-polyfill sprawdza `chrome.runtime.id` przy ładowaniu modułu.
  const noop = (): void => undefined;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: 'test',
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: () => Promise.resolve(undefined),
        onMessage: { addListener: noop },
        lastError: null,
      },
      tabs: {
        create: (properties: { url?: string }, callback?: () => void) => {
          openedTabs.push(properties.url ?? '');
          callback?.();
        },
        query: (_query: unknown, callback: (tabs: unknown[]) => void) => {
          callback([]);
        },
      },
    },
  });

  // jsdom nie implementuje `showModal`/`close` na <dialog> (Chrome i Firefox
  // w naszych wersjach minimalnych - tak). Podstawiamy minimalny odpowiednik.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });

  // jsdom nie liczy układu, a wirtualizacja potrzebuje wysokości okna.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });

  for (let i = 0; i < ITEMS; i += 1) {
    const item = await saveItem({
      url: `https://serwis-${String(i % 7)}.example/artykul-${String(i)}`,
      title: `Artykuł numer ${String(i)}`,
      excerpt: `Zajawka pozycji ${String(i)}`,
      wordCount: 400,
      savedAt: 1_700_000_000_000 + i * 1_000,
      tags: i % 3 === 0 ? ['rust'] : [],
    });
    if (i % 5 === 0) {
      await setContent(item.id, {
        html: `<p>Treść ${String(i)}</p>`,
        text: `Tekst pozycji ${String(i)} ze słowem lokomotywa`,
      });
    }
  }
});

afterAll(async () => {
  await deleteDb();
});

describe('pełna strona', () => {
  beforeAll(async () => {
    vi.resetModules();
    mount('?full=1');
    await import('./list');
    await settle(200);
  });

  it('trzyma w DOM-ie okno kart, nie całą listę', () => {
    expect(cards().length).toBeGreaterThan(0);
    expect(cards().length).toBeLessThan(20);
    // Rozpychacz odpowiada pełnej liście, więc pasek przewijania jest prawdziwy.
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(ITEMS * 104)}px`);
  });

  it('pokazuje najnowsze na górze i liczy zakładki', () => {
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Artykuł numer ${String(ITEMS - 1)}`,
    );
    const counts = [...document.querySelectorAll('.tab__count')].map((node) => node.textContent);
    expect(counts).toEqual([String(ITEMS), '0', '0']);
  });

  it('każda karta ma komplet akcji', () => {
    expect(document.querySelectorAll('.card:first-child .card__actions .icon')).toHaveLength(6);
  });

  it('czytnik otwiera się w nowej karcie i nie oznacza pozycji jako przeczytanej', async () => {
    openedTabs.length = 0;

    document.querySelector<HTMLButtonElement>('.card:first-child .card__actions .icon')?.click();
    await settle(30);

    const opened = openedTabs.at(-1) ?? '';
    expect(opened).toContain('ui/reader/index.html?id=');

    // O oznaczeniu jako przeczytane decyduje czytnik po dojściu do 90% treści.
    const id = new URL(opened).searchParams.get('id') ?? '';
    expect((await getItem(id))?.readAt).toBeNull();
  });

  it('przewijanie przesuwa okno, a nie dokłada wierszy', async () => {
    const scroller = document.querySelector<HTMLDivElement>('#scroller');
    if (scroller === null) throw new Error('brak kontenera przewijania');

    scroller.scrollTop = 100 * 104;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(cards().length).toBeLessThan(20);
    expect(document.querySelector('.card__title')?.textContent).toContain('Artykuł numer');
    expect(document.querySelector('.card__title')?.textContent).not.toBe(
      `Artykuł numer ${String(ITEMS - 1)}`,
    );

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  it('zakładka archiwum jest pusta i mówi o tym wprost', async () => {
    document.querySelector<HTMLButtonElement>('[data-tab="archive"]')?.click();
    await settle(30);

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('#empty')?.textContent).toBe('Archiwum jest puste.');

    document.querySelector<HTMLButtonElement>('[data-tab="inbox"]')?.click();
    await settle(30);
  });

  it('szuka po tytule z debounce', async () => {
    const search = document.querySelector<HTMLInputElement>('#search');
    if (search === null) throw new Error('brak pola wyszukiwania');

    search.value = 'numer 137';
    search.dispatchEvent(new Event('input'));

    // Przed upływem debounce lista jeszcze się nie przeliczyła.
    await settle(60);
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Artykuł numer ${String(ITEMS - 1)}`,
    );

    await settle(200);
    expect(document.querySelector('.card__title')?.textContent).toBe('Artykuł numer 137');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(200);
  });

  it('obsługuje klawiaturę: strzałki, / i ?', async () => {
    const selectedIndex = (): string | undefined =>
      document.querySelector<HTMLLIElement>('.card[aria-selected="true"]')?.dataset['index'];

    const key = (init: KeyboardEventInit): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    };

    key({ key: 'ArrowDown' });
    await settle(30);
    expect(selectedIndex()).toBe('0');

    key({ key: 'ArrowDown' });
    await settle(30);
    expect(selectedIndex()).toBe('1');

    key({ key: 'ArrowUp' });
    await settle(30);
    expect(selectedIndex()).toBe('0');

    key({ key: '/' });
    expect(document.activeElement).toBe(document.querySelector('#search'));

    // Skróty nie mogą działać w polu tekstowym - to zwykłe pisanie.
    document.querySelector<HTMLInputElement>('#search')?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'a' }),
    );
    await settle(30);
    expect(selectedIndex()).toBe('0');

    document.querySelector<HTMLInputElement>('#search')?.blur();
    key({ key: '?' });
    expect(document.querySelector<HTMLDialogElement>('#help-dialog')?.open).toBe(true);
    key({ key: '?' });
    expect(document.querySelector<HTMLDialogElement>('#help-dialog')?.open).toBe(false);
  });

  it('klik w tag włącza filtr, a chip go wyłącza', async () => {
    document.querySelector<HTMLButtonElement>('.card__tags .chip')?.click();
    await settle(30);
    expect(document.querySelector('#active-tags')?.textContent).toContain('#rust');
    for (const card of cards()) {
      expect(card.querySelector('.card__tags')?.textContent).toContain('#rust');
    }

    document.querySelector<HTMLButtonElement>('#active-tags .chip')?.click();
    await settle(30);
    expect(document.querySelector<HTMLElement>('#active-tags')?.hidden).toBe(true);
  });

  it('usunięcie pokazuje toast i daje się cofnąć', async () => {
    const first = document.querySelector('.card__title')?.textContent;

    document.querySelector<HTMLButtonElement>('.card__actions .icon:last-child')?.click();
    await settle(30);

    const toast = document.querySelector<HTMLElement>('#toast');
    expect(toast?.hidden).toBe(false);
    expect(toast?.textContent).toContain('Usunięto');
    expect(document.querySelector('.card__title')?.textContent).not.toBe(first);

    document.querySelector<HTMLButtonElement>('.toast__action')?.click();
    await settle(30);

    expect(document.querySelector<HTMLElement>('#toast')?.hidden).toBe(true);
    expect(document.querySelector('.card__title')?.textContent).toBe(first);
  });
});

describe('popup', () => {
  beforeAll(async () => {
    vi.resetModules();
    mount('');
    await import('./list');
    await settle(200);
  });

  it('pokazuje najwyżej 20 pozycji i przycisk do pełnej listy', () => {
    expect(document.body.dataset['mode']).toBe('popup');
    // 20 pozycji w modelu, w DOM-ie tylko okno widoczne na 600 px.
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(20 * 104)}px`);
    expect(cards().length).toBeLessThanOrEqual(20);

    const footer = document.querySelector<HTMLElement>('#footer');
    expect(footer?.hidden).toBe(false);
    expect(document.querySelector('#see-all')?.textContent).toBe(
      `Zobacz wszystkie (${String(ITEMS)})`,
    );
  });
});
