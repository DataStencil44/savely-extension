// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import html from './list.html?raw';
import { deleteDb, deleteItem, getItem, putFavicon, saveItem, setContent } from '@/lib/db';

const ITEMS = 300;

const ICON = 'data:image/png;base64,AAAA';
const ICON_DOMAIN = 'site-5.example';

const openedTabs: string[] = [];

const settingsStore: Record<string, unknown> = {};

type StorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) => void;

const storageListeners: StorageListener[] = [];

function announceFromElsewhere(): void {
  for (const listener of storageListeners) {
    listener(
      { 'savely:changed': { newValue: { at: Date.now(), source: 'another-context' } } },
      'local',
    );
  }
}

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

function toolbar(action: 'read' | 'favorite' | 'archive' | 'tags' | 'delete'): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`#item-${action}`);
  if (found === null) throw new Error(`no ${action} button`);
  return found;
}

async function selectFirstCard(): Promise<void> {
  document.querySelector('.card:first-child .card__title')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
  await settle(30);
}

beforeAll(async () => {
  await deleteDb();

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
      storage: {
        sync: {
          get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            callback(key !== undefined && key in settingsStore ? { [key]: settingsStore[key] } : {});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(settingsStore, items);
            callback();
          },
        },
        local: {
          get: (_keys: unknown, callback: (items: unknown) => void) => {
            callback({});
          },
          set: (_items: unknown, callback: () => void) => {
            callback();
          },
        },
        onChanged: {
          addListener: (listener: StorageListener) => storageListeners.push(listener),
        },
      },
    },
  });

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

  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });

  for (let i = 0; i < ITEMS; i += 1) {
    const item = await saveItem({
      url: `https://site-${String(i % 7)}.example/article-${String(i)}`,
      title: `Article number ${String(i)}`,
      excerpt: `Excerpt of item ${String(i)}`,
      wordCount: 400,
      savedAt: 1_700_000_000_000 + i * 1_000,
      tags: i % 3 === 0 ? ['rust'] : [],
    });
    if (i % 5 === 0) {
      await setContent(item.id, {
        html: `<p>Content ${String(i)}</p>`,
        text: `The text of item ${String(i)} with the word locomotive`,
      });
    }
  }

  await putFavicon(ICON_DOMAIN, ICON);
});

afterAll(async () => {
  await deleteDb();
});

describe('the full page', () => {
  beforeAll(async () => {
    vi.resetModules();
    mount('?full=1');
    await import('./list');
    await settle(200);
  });

  it('keeps a window of cards in the DOM, not the whole list', () => {
    expect(cards().length).toBeGreaterThan(0);
    expect(cards().length).toBeLessThan(20);
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(ITEMS * 104)}px`);
  });

  it('shows the newest on top and counts the tabs', () => {
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Article number ${String(ITEMS - 1)}`,
    );
    const counts = [...document.querySelectorAll('.tab__count')].map((node) => node.textContent);
    expect(counts).toEqual([String(ITEMS), '0', '0']);
  });

  it('the toolbar waits for a selection, then acts on it', async () => {
    const actions = ['read', 'favorite', 'archive', 'tags', 'delete'] as const;
    const title = (): string | null | undefined => document.querySelector('#item-title')?.textContent;

    for (const action of actions) expect(toolbar(action).disabled).toBe(true);
    expect(title()).toBe('');

    await selectFirstCard();

    for (const action of actions) expect(toolbar(action).disabled).toBe(false);
    expect(title()).toBe(`Article number ${String(ITEMS - 1)}`);
    expect(document.querySelector('.card[aria-selected="true"]')?.getAttribute('data-index')).toBe('0');
  });

  it('the toolbar shows the state of the selected item and changes it', async () => {
    const favorite = toolbar('favorite');
    const id = document.querySelector<HTMLLIElement>('.card[aria-selected="true"]')?.dataset['id'] ?? '';
    expect(favorite.getAttribute('aria-pressed')).toBe('false');

    favorite.click();
    await settle(50);
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    expect(favorite.title).toBe('Remove from favorites (f)');
    await expect(getItem(id)).resolves.toMatchObject({ favorite: true });

    favorite.click();
    await settle(50);
    expect(favorite.getAttribute('aria-pressed')).toBe('false');
    await expect(getItem(id)).resolves.toMatchObject({ favorite: false });
  });

  it('a card shows the icon of its site, and only of its own site', () => {
    const iconOf = (card: Element | undefined): HTMLImageElement | null =>
      card?.querySelector<HTMLImageElement>('.card__thumb') ?? null;
    const domainOf = (card: Element): string =>
      card.querySelector('.card__meta')?.textContent?.split(' · ')[0] ?? '';

    const withIcon = [...cards()].find((card) => domainOf(card) === ICON_DOMAIN);
    expect(iconOf(withIcon)?.hidden).toBe(false);
    expect(iconOf(withIcon)?.getAttribute('src')).toBe(ICON);

    const without = [...cards()].find((card) => domainOf(card) !== ICON_DOMAIN);
    expect(iconOf(without)?.hidden).toBe(true);
    expect(iconOf(without)?.getAttribute('src')).toBeNull();
  });

  it('starts light and the switcher cycles the theme for the whole UI', async () => {
    const button = document.querySelector<HTMLButtonElement>('#theme');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(button?.title).toContain('switch to Dark');

    button?.click();
    await settle(30);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(settingsStore['reader-settings']).toMatchObject({ theme: 'dark' });

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'd' }));
    await settle(30);
    expect(document.documentElement.dataset['theme']).toBe('sepia');

    button?.click();
    await settle(30);
    expect(document.documentElement.dataset['theme']).toBe('auto');

    button?.click();
    await settle(30);
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('the reader opens in a new tab and does not mark the item as read', async () => {
    openedTabs.length = 0;

    await selectFirstCard();
    toolbar('read').click();
    await settle(30);

    const opened = openedTabs.at(-1) ?? '';
    expect(opened).toContain('ui/reader/index.html?id=');

    const id = new URL(opened).searchParams.get('id') ?? '';
    expect((await getItem(id))?.readAt).toBeNull();
  });

  it('a double click on a card opens the original in a new tab', async () => {
    openedTabs.length = 0;

    const card = document.querySelector<HTMLLIElement>('.card:first-child');
    card?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle(30);

    const item = await getItem(card?.dataset['id'] ?? '');
    expect(openedTabs).toEqual([item?.resolvedUrl]);
  });

  it('scrolling moves the window rather than adding rows', async () => {
    const scroller = document.querySelector<HTMLDivElement>('#scroller');
    if (scroller === null) throw new Error('no scroll container');

    scroller.scrollTop = 100 * 104;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(cards().length).toBeLessThan(20);
    expect(document.querySelector('.card__title')?.textContent).toContain('Article number');
    expect(document.querySelector('.card__title')?.textContent).not.toBe(
      `Article number ${String(ITEMS - 1)}`,
    );

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  it('the archive tab is empty and says so plainly', async () => {
    document.querySelector<HTMLButtonElement>('[data-tab="archive"]')?.click();
    await settle(30);

    expect(cards()).toHaveLength(0);
    expect(document.querySelector('#empty')?.textContent).toBe('The archive is empty.');

    document.querySelector<HTMLButtonElement>('[data-tab="inbox"]')?.click();
    await settle(30);
  });

  it('searches by title with a debounce', async () => {
    const search = document.querySelector<HTMLInputElement>('#search');
    if (search === null) throw new Error('no search field');

    search.value = 'number 137';
    search.dispatchEvent(new Event('input'));

    await settle(60);
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Article number ${String(ITEMS - 1)}`,
    );

    await settle(200);
    expect(document.querySelector('.card__title')?.textContent).toBe('Article number 137');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(200);
  });

  it('handles the keyboard: arrows, / and ?', async () => {
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

  it('leaves Enter to the button that has focus', async () => {
    openedTabs.length = 0;

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    await settle(30);

    const remove = toolbar('delete');
    remove.focus();
    remove.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await settle(30);

    expect(openedTabs).toEqual([]);
  });

  it('`tag:` in the search box becomes the same filter a chip click makes', async () => {
    const search = document.querySelector<HTMLInputElement>('#search');
    if (search === null) throw new Error('no search field');

    search.value = 'tag:rust ';
    search.dispatchEvent(new Event('input'));
    await settle(200);

    expect(search.value).toBe('');
    expect(document.querySelector('#active-tags')?.textContent).toContain('#rust');
    for (const card of cards()) {
      expect(card.querySelector('.card__tags')?.textContent).toContain('#rust');
    }

    search.value = 'number 33 tag:rust';
    search.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await settle(60);
    expect(search.value).toBe('number 33');
    expect(document.querySelector('.card__title')?.textContent).toBe('Article number 33');

    document.querySelector<HTMLButtonElement>('#active-tags .chip')?.click();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(200);
    expect(document.querySelector<HTMLElement>('#active-tags')?.hidden).toBe(true);
  });

  it('a half-typed `tag:` does not empty the list before the space', async () => {
    const search = document.querySelector<HTMLInputElement>('#search');
    if (search === null) throw new Error('no search field');

    search.value = 'tag:ru';
    search.dispatchEvent(new Event('input'));
    await settle(200);

    expect(search.value).toBe('tag:ru');
    expect(document.querySelector<HTMLElement>('#active-tags')?.hidden).toBe(true);
    expect(cards().length).toBeGreaterThan(0);
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Article number ${String(ITEMS - 1)}`,
    );

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(200);
  });

  it('clicking a tag turns the filter on and the chip turns it off', async () => {
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

  it('the tags button opens the editor and a second press closes it', async () => {
    const press = (target: HTMLElement): void => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    await selectFirstCard();
    const tagsButton = toolbar('tags');
    const editor = document.querySelector<HTMLElement>('#tag-editor');

    press(tagsButton);
    await settle(30);
    expect(editor?.hidden).toBe(false);

    press(tagsButton);
    await settle(30);
    expect(editor?.hidden).toBe(true);
  });

  it('the tags button still closes the editor after a tag redrew the list', async () => {
    const press = (target: HTMLElement): void => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    const editor = document.querySelector<HTMLElement>('#tag-editor');

    press(toolbar('tags'));
    await settle(30);
    expect(editor?.hidden).toBe(false);

    const input = editor?.querySelector<HTMLInputElement>('.tag-editor__input');
    if (input === undefined || input === null) throw new Error('no tag input');
    input.value = 'locomotive';
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await settle(50);
    expect(editor?.hidden).toBe(false);

    press(toolbar('tags'));
    await settle(30);
    expect(editor?.hidden).toBe(true);
  });

  it('a deletion shows a toast and can be undone', async () => {
    const card = document.querySelector<HTMLLIElement>('.card');
    const first = card?.querySelector('.card__title')?.textContent;
    const id = card?.dataset['id'] ?? '';

    await selectFirstCard();
    toolbar('delete').click();
    await settle(30);

    const toast = document.querySelector<HTMLElement>('#toast');
    expect(toast?.hidden).toBe(false);
    expect(toast?.textContent).toContain('Deleted');
    expect(document.querySelector('.card__title')?.textContent).not.toBe(first);

    await expect(getItem(id)).resolves.toBeUndefined();

    document.querySelector<HTMLButtonElement>('.toast__action')?.click();
    await settle(50);

    expect(document.querySelector<HTMLElement>('#toast')?.hidden).toBe(true);
    expect(document.querySelector('.card__title')?.textContent).toBe(first);
    await expect(getItem(id)).resolves.toMatchObject({ id });
  });

  it('a double click on Delete deletes one item, not the next one as well', async () => {
    const [first, second] = [...cards()].map((card) => card.dataset['id'] ?? '');

    await selectFirstCard();
    toolbar('delete').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    toolbar('delete').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    await settle(50);

    await expect(getItem(first ?? '')).resolves.toBeUndefined();
    await expect(getItem(second ?? '')).resolves.toMatchObject({ id: second });

    document.querySelector<HTMLButtonElement>('.toast__action')?.click();
    await settle(50);
    await expect(getItem(first ?? '')).resolves.toMatchObject({ id: first });
  });

  it('picks up what another context saved, and what it deleted', async () => {
    const saved = await saveItem({
      url: 'https://elsewhere.example/fresh',
      title: 'Saved from the toolbar',
      excerpt: '',
      wordCount: 100,
      savedAt: 1_700_000_000_000 + 1_000_000,
    });

    announceFromElsewhere();
    await settle(200);

    expect(document.querySelector('.card__title')?.textContent).toBe('Saved from the toolbar');
    expect(document.querySelector('.tab__count')?.textContent).toBe(String(ITEMS + 1));

    await deleteItem(saved.id);
    announceFromElsewhere();
    await settle(200);

    expect(document.querySelector('.tab__count')?.textContent).toBe(String(ITEMS));
  });
});

describe('popup', () => {
  beforeAll(async () => {
    vi.resetModules();
    mount('');
    await import('./list');
    await settle(200);
  });

  it('shows at most 20 items and a button to the full list', () => {
    expect(document.body.dataset['mode']).toBe('popup');
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(20 * 104)}px`);
    expect(cards().length).toBeLessThanOrEqual(20);

    const footer = document.querySelector<HTMLElement>('#footer');
    expect(footer?.hidden).toBe(false);
    expect(document.querySelector('#see-all')?.textContent).toBe(
      `See all (${String(ITEMS)})`,
    );
  });
});
