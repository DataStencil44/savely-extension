// @vitest-environment jsdom
/**
 * A list-view test on jsdom: we mount the real `list.html`, run `list.ts` and
 * click the way a user would.
 *
 * What we check above all is what the unit tests cannot see: that the
 * virtualization keeps a dozen or so cards in the DOM regardless of list
 * length, and that the popup and the full page differ in exactly the ways they
 * should.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import html from './list.html?raw';
import { deleteDb, getItem, saveItem, setContent } from '@/lib/db';

const ITEMS = 300;

/** The addresses passed to `tabs.create` - this is how we know what opened in a new tab. */
const openedTabs: string[] = [];

/**
 * The page markup without `<script>` - we load the module ourselves, once the
 * DOM is ready. It is assembled with DOMParser rather than `innerHTML`: the same
 * rule holds in the tests as in the code (CLAUDE.md 3).
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

  // webextension-polyfill checks `chrome.runtime.id` when the module loads.
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

  // jsdom does not implement `showModal`/`close` on <dialog> (Chrome and
  // Firefox at our minimum versions do). We substitute a minimal equivalent.
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

  // jsdom computes no layout, and the virtualization needs the viewport height.
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
    // The spacer matches the full list, so the scrollbar tells the truth.
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(ITEMS * 104)}px`);
  });

  it('shows the newest on top and counts the tabs', () => {
    expect(document.querySelector('.card__title')?.textContent).toBe(
      `Article number ${String(ITEMS - 1)}`,
    );
    const counts = [...document.querySelectorAll('.tab__count')].map((node) => node.textContent);
    expect(counts).toEqual([String(ITEMS), '0', '0']);
  });

  it('every card carries the full set of actions', () => {
    expect(document.querySelectorAll('.card:first-child .card__actions .icon')).toHaveLength(6);
  });

  it('the reader opens in a new tab and does not mark the item as read', async () => {
    openedTabs.length = 0;

    document
      .querySelector<HTMLButtonElement>('.card:first-child .card__actions [aria-label^="Read"]')
      ?.click();
    await settle(30);

    const opened = openedTabs.at(-1) ?? '';
    expect(opened).toContain('ui/reader/index.html?id=');

    // The reader decides on the read mark after reaching 90% of the content.
    const id = new URL(opened).searchParams.get('id') ?? '';
    expect((await getItem(id))?.readAt).toBeNull();
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

    // Before the debounce elapses the list has not recomputed yet.
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

    // Shortcuts must not fire inside a text field - that is ordinary typing.
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
      // A real press is mousedown then click - the panel closes on the first.
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };

    const tagsButton = document.querySelector<HTMLButtonElement>(
      '.card:first-child .card__actions [aria-label^="Tags"]',
    );
    if (tagsButton === null) throw new Error('no tags button');
    const editor = document.querySelector<HTMLElement>('#tag-editor');

    press(tagsButton);
    await settle(30);
    expect(editor?.hidden).toBe(false);

    press(tagsButton);
    await settle(30);
    expect(editor?.hidden).toBe(true);
  });

  it('the tags button still closes the editor after a render replaced it', async () => {
    const press = (target: HTMLElement): void => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    const tagsButton = (): HTMLButtonElement => {
      const found = document.querySelector<HTMLButtonElement>(
        '.card:first-child .card__actions [aria-label^="Tags"]',
      );
      if (found === null) throw new Error('no tags button');
      return found;
    };
    const editor = document.querySelector<HTMLElement>('#tag-editor');

    press(tagsButton());
    await settle(30);
    expect(editor?.hidden).toBe(false);

    // A tag lands in the database and the list rebuilds its cards - the button
    // under the cursor is now a different element for the same item.
    const input = editor?.querySelector<HTMLInputElement>('.tag-editor__input');
    if (input === undefined || input === null) throw new Error('no tag input');
    input.value = 'locomotive';
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await settle(50);
    expect(editor?.hidden).toBe(false);

    press(tagsButton());
    await settle(30);
    expect(editor?.hidden).toBe(true);
  });

  it('a deletion shows a toast and can be undone', async () => {
    const first = document.querySelector('.card__title')?.textContent;

    document.querySelector<HTMLButtonElement>('.card__actions .icon:last-child')?.click();
    await settle(30);

    const toast = document.querySelector<HTMLElement>('#toast');
    expect(toast?.hidden).toBe(false);
    expect(toast?.textContent).toContain('Deleted');
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

  it('shows at most 20 items and a button to the full list', () => {
    expect(document.body.dataset['mode']).toBe('popup');
    // 20 items in the model, in the DOM only the window visible at 600 px.
    expect(document.querySelector<HTMLElement>('#sizer')?.style.height).toBe(`${String(20 * 104)}px`);
    expect(cards().length).toBeLessThanOrEqual(20);

    const footer = document.querySelector<HTMLElement>('#footer');
    expect(footer?.hidden).toBe(false);
    expect(document.querySelector('#see-all')?.textContent).toBe(
      `See all (${String(ITEMS)})`,
    );
  });
});
