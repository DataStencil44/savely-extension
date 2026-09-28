// @vitest-environment jsdom
/**
 * A reader test on jsdom: we mount the real `index.html`, run `reader.ts` and
 * check what the unit tests cannot see - that the content reaches the DOM after
 * sanitization, that highlights are restored, and that settings from
 * `storage.sync` really do change the appearance.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import html from './index.html?raw';

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

/** `storage.onChanged` subscribers, so a test can play another tab writing. */
const changeListeners = vi.hoisted((): ChangeListener[] => []);

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
          // Where `announceChange` writes; nothing here reads it back.
          set: (_items: unknown, callback: () => void) => {
            callback();
          },
        },
        onChanged: {
          addListener: (listener: ChangeListener) => {
            changeListeners.push(listener);
          },
        },
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

const { addHighlight, deleteDb, deleteHighlight, getItem, listHighlights, saveItem, setContent } =
  await import('@/lib/db');

const ARTICLE = [
  '<p>The city council adopted a resolution changing traffic patterns in the centre.</p>',
  '<figure><img src="https://cdn.example/street.jpg" alt="A street"><figcaption>The street after the rebuild</figcaption></figure>',
  '<h2>What will change</h2>',
  '<p>The pavements will be widened at the expense of parking spaces along the roadway.</p>',
].join('');

let itemId = '';

/** We fake the document and window height ourselves - jsdom computes no layout. */
const PAGE_HEIGHT = 2_000;
const VIEWPORT = 800;
let scrollTop = 0;

/** Scrolls the page to the given fraction of the content and waits for the handler. */
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
    url: 'https://daily.example/article',
    title: 'A centre without cars',
    byline: 'Anna Kowalska',
    wordCount: 400,
    savedAt: 1_700_000_000_000,
  });
  itemId = item.id;

  await setContent(item.id, { html: ARTICLE, text: 'irrelevant for this test' });

  // A highlight stored earlier - the offsets come from the article text.
  await addHighlight({
    itemId: item.id,
    text: 'traffic patterns',
    start: 45,
    end: 61,
    prefix: 'a resolution changing ',
    suffix: ' in the centre.',
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

describe('the reader', () => {
  it('shows the header with the metadata', () => {
    expect(document.querySelector('.title')?.textContent).toBe('A centre without cars');
    expect(document.querySelector('.meta')?.textContent).toContain('Anna Kowalska');
    expect(document.querySelector('.meta')?.textContent).toContain('daily.example');
  });

  it('inserts the content after sanitization, with the figure caption', () => {
    const content = document.querySelector('.content');
    expect(content?.querySelectorAll('p')).toHaveLength(2);
    expect(content?.querySelector('h2')?.textContent).toBe('What will change');
    expect(content?.querySelector('figcaption')?.textContent).toBe('The street after the rebuild');
    expect(content?.querySelector('script')).toBeNull();
  });

  it('restores a stored highlight from its text offsets', () => {
    const mark = document.querySelector('mark[data-highlight]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('traffic patterns');
  });

  it('applies the settings from storage.sync', () => {
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe('sepia');
    expect(root.dataset['family']).toBe('dyslexia');
    expect(root.style.getPropertyValue('--font-size')).toBe('22px');
    expect(root.style.getPropertyValue('--column-width')).toBe('68ch');
  });

  it('a size change is saved and takes effect immediately', async () => {
    document.querySelector<HTMLButtonElement>('[data-font-size="1"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('23px');
    expect(settingsStore['reader-settings']).toMatchObject({ fontSize: 23 });
  });

  it('turning off remote images strips src and can be undone', async () => {
    const image = document.querySelector<HTMLImageElement>('.content img');
    expect(image?.getAttribute('src')).toBe('https://cdn.example/street.jpg');

    const checkbox = document.querySelector<HTMLInputElement>('#remote-images');
    if (checkbox === null) throw new Error('no remote-images toggle');

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(image?.getAttribute('src')).toBeNull();
    expect(image?.classList.contains('blocked')).toBe(true);
    expect(settingsStore['reader-settings']).toMatchObject({ remoteImages: false });

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(image?.getAttribute('src')).toBe('https://cdn.example/street.jpg');
  });

  it('marks as read only after reaching 90% of the content', async () => {
    await scrollToRatio(0.5);
    expect(document.querySelector<HTMLElement>('#progress-bar')?.style.width).toBe('50%');
    expect((await getItem(itemId))?.readAt).toBeNull();

    await scrollToRatio(0.95);
    expect(document.querySelector<HTMLElement>('#progress-bar')?.style.width).toBe('95%');
    expect((await getItem(itemId))?.readAt).not.toBeNull();
  });

  it('the f shortcut toggles the favorite', async () => {
    const favorite = document.querySelector<HTMLButtonElement>('#favorite');
    expect(favorite?.getAttribute('aria-pressed')).toBe('false');

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'f' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(favorite?.getAttribute('aria-pressed')).toBe('true');
  });

  it('repaints the highlights when another context changes them', async () => {
    const [stored] = await listHighlights(itemId);
    if (stored === undefined) throw new Error('missing test data');
    // Another tab (or a sync) removes the stored highlight and adds one of its own.
    await deleteHighlight(stored.id);
    await addHighlight({ itemId, text: 'pavements', start: 138, end: 147 });

    for (const listener of changeListeners) {
      listener({ 'savely:changed': { newValue: { at: Date.now(), source: 'another-tab' } } }, 'local');
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    const marks = [...document.querySelectorAll('mark[data-highlight]')].map((mark) => mark.textContent);
    expect(marks).toEqual(['pavements']);
  });
});
