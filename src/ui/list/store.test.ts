import { describe, expect, it } from 'vitest';

import type { SavedItem } from '@/types/item';

import { ListStore } from './store';

const DAY = 24 * 60 * 60 * 1000;

interface ItemOverrides {
  id?: string;
  title?: string;
  tags?: string[];
  archived?: boolean;
  favorite?: boolean;
  age?: number;
  contentHash?: string | null;
}

function item(overrides: ItemOverrides = {}): SavedItem {
  const id = overrides.id ?? 'i1';
  const savedAt = Date.now() - (overrides.age ?? 0) * DAY;

  return {
    id,
    url: `https://example.com/${id}`,
    resolvedUrl: `https://example.com/${id}`,
    title: overrides.title ?? 'A centre without cars',
    excerpt: '',
    byline: null,
    siteName: null,
    lang: null,
    wordCount: 400,
    estReadingMinutes: 2,
    savedAt,
    updatedAt: savedAt,
    readAt: null,
    archived: overrides.archived ?? false,
    favorite: overrides.favorite ?? false,
    tags: overrides.tags ?? [],
    contentHash: overrides.contentHash ?? null,
    status: 'ready',
    readingProgress: 0,
    archivedKey: overrides.archived === true ? 1 : 0,
  };
}

function ids(store: ListStore): string[] {
  return store.view.visible.map((entry) => entry.id);
}

function seeded(options?: ConstructorParameters<typeof ListStore>[0]): ListStore {
  const store = new ListStore(options);
  store.setItems([
    item({ id: 'a', title: 'Trams in Vienna', tags: ['transit'], age: 0 }),
    item({ id: 'b', title: 'Cycling in Utrecht', tags: ['transit', 'cities'], age: 1 }),
    item({ id: 'c', title: 'Rust and borrowing', tags: ['rust'], age: 2, favorite: true }),
    item({ id: 'd', title: 'Rust, archived', tags: ['rust'], age: 3, archived: true }),
  ]);
  return store;
}

describe('the tabs', () => {
  it('the inbox is everything unarchived, newest first', () => {
    expect(ids(seeded())).toEqual(['a', 'b', 'c']);
  });

  it('each tab holds its own, and the archive is not the inbox', () => {
    const store = seeded();

    store.setTab('favorite');
    expect(ids(store)).toEqual(['c']);

    store.setTab('archive');
    expect(ids(store)).toEqual(['d']);
  });

  it('the badges count the whole library, so they hold still while you filter', () => {
    const store = seeded();
    store.addTag('rust');

    expect(ids(store)).toEqual(['c']);
    expect(store.view.counts).toEqual({ inbox: 3, favorite: 1, archive: 1 });
  });
});

describe('the tag filter', () => {
  it('two tags mean both, not either', () => {
    const store = seeded();

    store.addTag('transit');
    expect(ids(store)).toEqual(['a', 'b']);

    store.addTag('cities');
    expect(ids(store)).toEqual(['b']);

    store.removeTag('cities');
    expect(ids(store)).toEqual(['a', 'b']);
  });

  it('the same tag twice is still one filter', () => {
    const store = seeded();
    store.addTag('transit');
    store.addTag('transit');
    expect(store.tags).toEqual(['transit']);
  });
});

describe('the search', () => {
  it('ranks by the index and stays inside the tab in view', () => {
    const store = seeded();

    store.applyQuery('rust');
    expect(ids(store)).toEqual(['c']);

    store.setTab('archive');
    expect(ids(store)).toEqual(['d']);
  });

  it('combines with a tag filter rather than replacing it', () => {
    const store = seeded();
    store.addTag('transit');
    store.applyQuery('cycling');
    expect(ids(store)).toEqual(['b']);
  });

  it('a `tag:` token arrives as a filter alongside the words', () => {
    const store = seeded();
    store.applyQuery('cycling', ['transit']);
    expect(store.tags).toEqual(['transit']);
    expect(ids(store)).toEqual(['b']);
  });
});

describe('the index and the items', () => {
  it('a deleted item is gone from the search too, not just from the list', () => {
    const store = seeded();
    store.remove('c');

    expect(ids(store)).toEqual(['a', 'b']);
    store.applyQuery('rust');
    expect(ids(store)).toEqual([]);
  });

  it('a changed title is searchable by the new one', () => {
    const store = seeded();
    store.replace({ ...item({ id: 'a', tags: ['transit'] }), title: 'Trolleybuses in Gdynia' });

    store.applyQuery('trolleybuses');
    expect(ids(store)).toEqual(['a']);
  });

  it('an undone deletion comes back in its place by date, and findable', () => {
    const store = seeded();
    const restored = store.items.find((entry) => entry.id === 'b');
    if (restored === undefined) throw new Error('the fixture lost an item');

    store.remove('b');
    store.restore(restored);

    expect(ids(store)).toEqual(['a', 'b', 'c']);
    store.applyQuery('utrecht');
    expect(ids(store)).toEqual(['b']);
  });

  it('content read later joins the index the search already used', () => {
    const store = seeded();
    store.applyQuery('kerbside');
    expect(ids(store)).toEqual([]);

    store.setContentText('a', 'The kerbside is the cheapest land a city owns.');
    store.refresh();
    expect(ids(store)).toEqual(['a']);
  });
});

describe('the selection', () => {
  it('is clamped to the list at both ends', () => {
    const store = seeded();
    expect(store.select(-5)).toBe(0);
    expect(store.select(99)).toBe(2);
    expect(store.selectedItem()?.id).toBe('c');
  });

  it('a filter that shortens the list pulls the selection back into it', () => {
    const store = seeded();
    store.select(2);
    store.addTag('transit');
    expect(store.view.selected).toBe(1);
  });

  it('starts over on a new tab or a new search, and holds on a tag click', () => {
    const store = seeded();

    store.select(1);
    store.setTab('inbox');
    expect(store.view.selected).toBe(-1);

    store.select(1);
    store.applyQuery('in');
    expect(store.view.selected).toBe(-1);

    store.applyQuery('');
    store.select(1);
    store.addTag('transit');
    expect(store.view.selected).toBe(1);
  });

  it('an empty list cannot be selected into', () => {
    const store = new ListStore();
    store.setItems([]);
    expect(store.select(0)).toBe(-1);
    expect(store.selectedItem()).toBeUndefined();
  });
});

describe('the popup', () => {
  it('shows the top of the list and still reports how much there is', () => {
    const store = new ListStore({ limit: 2 });
    store.setItems([
      item({ id: 'a', age: 0 }),
      item({ id: 'b', age: 1 }),
      item({ id: 'c', age: 2 }),
    ]);

    expect(ids(store)).toEqual(['a', 'b']);
    expect(store.view.matched).toBe(3);
  });
});

describe('an empty list', () => {
  it('says which of the reasons it is', () => {
    const store = seeded();

    store.applyQuery('nothing matches this');
    expect(store.emptyMessage()).toContain('No results');

    store.applyQuery('');
    store.addTag('nonexistent');
    expect(store.emptyMessage()).toBe('No item has all of the selected tags.');

    store.removeTag('nonexistent');
    store.setTab('archive');
    store.remove('d');
    expect(store.emptyMessage()).toBe('The archive is empty.');
  });
});

describe('subscribers', () => {
  it('hear about every change, including a move of the selection', () => {
    const store = seeded();
    const views: number[] = [];
    store.subscribe((view) => views.push(view.selected));

    store.select(1);
    store.setTab('archive');
    expect(views).toEqual([1, -1]);
  });
});

describe('a fresh read of the database', () => {
  it('keeps the content already indexed, so a save elsewhere does not blind the search', () => {
    const store = seeded();
    store.setContentText('a', 'the tram network carries a million passengers');

    store.setItems([item({ id: 'new', title: 'Something else', age: -1 }), ...store.items]);

    store.applyQuery('passengers');
    expect(ids(store)).toEqual(['a']);
  });

  it('answers with the items whose content the index still needs', () => {
    const store = new ListStore();
    expect(store.setItems([item({ id: 'a', contentHash: 'h1' }), item({ id: 'b', age: 1 })])).toEqual([
      'a',
      'b',
    ]);

    const stale = store.setItems([
      item({ id: 'a', contentHash: 'h2' }),
      item({ id: 'b', age: 1 }),
      item({ id: 'c', age: 2 }),
    ]);
    expect(stale).toEqual(['a', 'c']);
  });

  it('drops what the database no longer has from the search', () => {
    const store = seeded();
    store.setItems(store.items.filter((entry) => entry.id !== 'a'));

    store.applyQuery('Vienna');
    expect(ids(store)).toEqual([]);
  });

  it('re-indexes a title changed elsewhere', () => {
    const store = seeded();
    store.setItems(store.items.map((entry) => (entry.id === 'b' ? { ...entry, title: 'Bikes in Delft' } : entry)));

    store.applyQuery('Delft');
    expect(ids(store)).toEqual(['b']);
    store.applyQuery('Utrecht');
    expect(ids(store)).toEqual([]);
  });
});
