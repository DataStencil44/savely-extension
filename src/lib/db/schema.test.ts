import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_VERSION,
  addHighlight,
  closeDb,
  deleteDb,
  getContent,
  getItem,
  listHighlights,
  openDb,
  saveItem,
  setContent,
  updateItem,
  type Migration,
  type SavedItem,
} from './index';

async function countItems(): Promise<number> {
  const db = await openDb();
  return db.count('items');
}

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('migrations', () => {
  function withoutFields<T extends Record<string, unknown>>(value: T, fields: readonly string[]): T {
    const record: Record<string, unknown> = { ...value };
    for (const field of fields) delete record[field];
    return record as T;
  }

  function sampleItem(id: string, title: string): SavedItem {
    return {
      id,
      url: `https://example.com/${id}`,
      resolvedUrl: `https://example.com/${id}`,
      title,
      excerpt: 'an excerpt',
      byline: null,
      siteName: null,
      lang: 'en',
      wordCount: 100,
      estReadingMinutes: 1,
      savedAt: 1_000,
      updatedAt: 1_000,
      readAt: null,
      archived: false,
      favorite: true,
      tags: ['rust'],
      contentHash: 'sha256-a',
      status: 'ready',
      readingProgress: 0,
      archivedKey: 0,
    };
  }

  it('a real 1 -> 2 migration adds fields and leaves the data alone', async () => {
    const v1 = await openDb({ version: 1 });
    const item = sampleItem('old-1', 'First');
    await v1.put('items', withoutFields({ ...item }, ['readingProgress']));
    await v1.put('contents', { itemId: item.id, html: '<p>x</p>', text: 'x', updatedAt: 5 });
    await v1.put(
      'highlights',
      withoutFields(
        {
          id: 'h1',
          itemId: item.id,
          text: 'a quote',
          note: 'a note',
          createdAt: 7,
          start: 0,
          end: 0,
          prefix: '',
          suffix: '',
        },
        ['start', 'end', 'prefix', 'suffix'],
      ),
    );
    v1.close();

    const migrated = await getItem(item.id);
    expect(migrated?.readingProgress).toBe(0);
    expect(migrated?.title).toBe('First');
    expect(migrated?.favorite).toBe(true);
    expect(migrated?.tags).toEqual(['rust']);
    expect(migrated?.contentHash).toBe('sha256-a');

    await expect(getContent(item.id)).resolves.toMatchObject({ text: 'x' });

    const [highlight] = await listHighlights(item.id);
    expect(highlight).toMatchObject({ text: 'a quote', note: 'a note', start: 0, end: 0, prefix: '' });
  });

  it('version 6 adds an empty sync base and leaves the items alone', async () => {
    const v5 = await openDb({ version: 5 });
    await v5.put('items', {
      id: 'legacy',
      url: 'https://example.com/a',
      resolvedUrl: 'https://example.com/a',
      title: 'Kept',
      excerpt: '',
      byline: null,
      siteName: null,
      lang: null,
      wordCount: 0,
      estReadingMinutes: 1,
      savedAt: 1_000,
      updatedAt: 1_000,
      readAt: null,
      archived: false,
      favorite: false,
      tags: ['rust'],
      contentHash: null,
      status: 'ready',
      readingProgress: 0,
      archivedKey: 0,
    });
    v5.close();

    const db = await openDb();
    expect(db.objectStoreNames.contains('syncBase')).toBe(true);
    await expect(db.count('syncBase')).resolves.toBe(0);
    await expect(getItem('legacy')).resolves.toMatchObject({ title: 'Kept', tags: ['rust'] });
  });

  const NEXT_VERSION = DB_VERSION + 1;

  const addFlag: Migration = async (_db, tx) => {
    const store = tx.objectStore('items');
    let cursor = await store.openCursor();
    while (cursor !== null) {
      const migrated = { ...cursor.value, pinned: false };
      await cursor.update(migrated);
      cursor = await cursor.continue();
    }
  };

  it('raising the version by one adds a field and deletes no data', async () => {
    const first = await saveItem({
      url: 'https://example.com/a',
      title: 'First',
      tags: ['rust'],
      savedAt: 1_000,
    });
    const second = await saveItem({
      url: 'https://example.com/b',
      title: 'Second',
      savedAt: 2_000,
    });
    await updateItem(second.id, { archived: true, favorite: true, readAt: 3_000 });
    await setContent(first.id, { html: '<p>content</p>', text: 'content', contentHash: 'sha256-a' });
    await addHighlight({ itemId: first.id, text: 'a highlight', createdAt: 500, start: 2, end: 13 });

    await closeDb();

    const db = await openDb({ version: NEXT_VERSION, migrations: { [NEXT_VERSION]: addFlag } });

    try {
      expect(db.version).toBe(NEXT_VERSION);
      expect([...db.objectStoreNames].sort()).toEqual([
        'contents',
        'favicons',
        'highlights',
        'items',
        'snapshots',
        'syncBase',
        'tombstones',
      ]);

      const items = (await db.getAll('items')) as (SavedItem & { pinned?: boolean })[];
      expect(items).toHaveLength(2);

      const migratedFirst = items.find((entry) => entry.id === first.id);
      const migratedSecond = items.find((entry) => entry.id === second.id);

      expect(migratedFirst?.pinned).toBe(false);
      expect(migratedSecond?.pinned).toBe(false);

      expect(migratedFirst?.title).toBe('First');
      expect(migratedFirst?.tags).toEqual(['rust']);
      expect(migratedFirst?.status).toBe('ready');
      expect(migratedFirst?.readingProgress).toBe(0);
      expect(migratedSecond?.archived).toBe(true);
      expect(migratedSecond?.readAt).toBe(3_000);

      await expect(db.get('contents', first.id)).resolves.toMatchObject({ text: 'content' });
      const highlights = await db.getAllFromIndex('highlights', 'itemId', first.id);
      expect(highlights).toHaveLength(1);
      expect(highlights[0]).toMatchObject({ start: 2, end: 13 });

      const tx = db.transaction('items', 'readonly');
      expect([...tx.store.indexNames].sort()).toEqual(['archived', 'savedAt', 'tags', 'url']);
      await expect(tx.store.index('archived').count(1)).resolves.toBe(1);
      await expect(tx.store.index('tags').count('rust')).resolves.toBe(1);
      await tx.done;
    } finally {
      db.close();
    }
  });

  it('a missing migration aborts the upgrade instead of breaking the schema', async () => {
    await saveItem({ url: 'https://example.com/a', title: 'Stays' });
    await closeDb();

    await expect(openDb({ version: NEXT_VERSION, migrations: {} })).rejects.toThrow();

    await expect(countItems()).resolves.toBe(1);
  });
});
