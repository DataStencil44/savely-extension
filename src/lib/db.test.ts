/**
 * Storage-layer tests on `fake-indexeddb`.
 *
 * Every test gets a clean database (`deleteDb` in `beforeEach`), because the
 * module keeps a shared connection and versions/data would otherwise leak
 * between tests.
 */
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  DB_VERSION,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LIMIT,
  addHighlight,
  applySync,
  clearAllData,
  closeDb,
  createSnapshot,
  createSnapshotIfDue,
  dataStats,
  deleteDb,
  deleteItem,
  exportAll,
  getContent,
  getItem,
  getItemByUrl,
  importDump,
  listAllItems,
  listHighlights,
  listSnapshots,
  listTombstones,
  openDb,
  restoreItem,
  restoreSnapshot,
  saveItem,
  setContent,
  toggleItem,
  updateItem,
  type Migration,
  type SavedItem,
} from './db';
import { normalizeTags, normalizeUrl } from './url';

/** Counted straight from the store, so a count never depends on a read path under test. */
async function countItems(): Promise<number> {
  const db = await openDb();
  return db.count('items');
}

async function countArchived(): Promise<number> {
  const db = await openDb();
  return db.countFromIndex('items', 'archived', 1);
}

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('normalizeUrl', () => {
  it('strips tracking parameters', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(normalizeUrl('https://example.com/a?fbclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?gclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?ref=newsletter')).toBe('https://example.com/a');
  });

  it('keeps parameters that identify the content, and the fragment', () => {
    expect(normalizeUrl('https://example.com/?p=123&utm_campaign=q#chapter-2')).toBe(
      'https://example.com/?p=123#chapter-2',
    );
  });

  it('leaves no orphaned question mark', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x')).toBe('https://example.com/a');
  });

  it('an unparseable address comes back unchanged', () => {
    expect(normalizeUrl('  not-a-url  ')).toBe('not-a-url');
  });
});

describe('normalizeTags', () => {
  it('trims, lowercases, drops duplicates and sorts', () => {
    expect(normalizeTags([' Rust ', 'rust', 'TypeScript', '', '   '])).toEqual([
      'rust',
      'typescript',
    ]);
  });
});

describe('saveItem', () => {
  it('creates an item with the default values', async () => {
    const item = await saveItem({
      url: 'https://example.com/article',
      title: 'An article',
      wordCount: 400,
    });

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.url).toBe('https://example.com/article');
    expect(item.resolvedUrl).toBe('https://example.com/article');
    expect(item.status).toBe('pending');
    expect(item.archived).toBe(false);
    expect(item.favorite).toBe(false);
    expect(item.readAt).toBeNull();
    expect(item.tags).toEqual([]);
    expect(item.estReadingMinutes).toBe(2);
    expect(item.archivedKey).toBe(0);

    await expect(getItem(item.id)).resolves.toEqual(item);
  });

  it('stores the normalized address but keeps the original', async () => {
    const item = await saveItem({ url: 'https://example.com/a?utm_source=newsletter&id=7' });

    expect(item.url).toBe('https://example.com/a?id=7');
    expect(item.resolvedUrl).toBe('https://example.com/a?utm_source=newsletter&id=7');
  });

  it('on a redirect it deduplicates by the destination address', async () => {
    const item = await saveItem({
      url: 'https://shortener.example/xyz',
      resolvedUrl: 'https://example.com/target',
    });

    expect(item.url).toBe('https://example.com/target');
    expect(item.resolvedUrl).toBe('https://example.com/target');
  });

  it('the same address creates no duplicate, it refreshes the entry', async () => {
    const first = await saveItem({
      url: 'https://example.com/a',
      title: 'Old title',
      tags: ['rust'],
      savedAt: 1_000,
      wordCount: 100,
    });
    await updateItem(first.id, { favorite: true, archived: true, readAt: 2_000 });

    const second = await saveItem({
      url: 'https://example.com/a?utm_source=twitter&fbclid=abc',
      title: 'New title',
      tags: ['TypeScript'],
      savedAt: 5_000,
      wordCount: 800,
    });

    expect(second.id).toBe(first.id);
    await expect(countItems()).resolves.toBe(1);

    // the metadata is refreshed
    expect(second.title).toBe('New title');
    expect(second.wordCount).toBe(800);
    expect(second.estReadingMinutes).toBe(4);
    expect(second.savedAt).toBe(5_000);

    // the user state is untouched, the tags are unioned
    expect(second.favorite).toBe(true);
    expect(second.archived).toBe(true);
    expect(second.readAt).toBe(2_000);
    expect(second.tags).toEqual(['rust', 'typescript']);
  });

  it('getItemByUrl finds the item despite tracking parameters', async () => {
    const saved = await saveItem({ url: 'https://example.com/a' });
    const found = await getItemByUrl('https://example.com/a?utm_campaign=x');

    expect(found?.id).toBe(saved.id);
  });
});

describe('listAllItems', () => {
  it('returns every item newest-first, ties broken the same way every time', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await saveItem({
        url: `https://example.com/${String(i)}`,
        title: `Article ${String(i)}`,
        savedAt: i * 1_000,
      });
    }
    const tied = [
      await saveItem({ url: 'https://example.com/tie-a', savedAt: 500 }),
      await saveItem({ url: 'https://example.com/tie-b', savedAt: 500 }),
    ];

    const items = await listAllItems();

    expect(items.slice(0, 3).map((item) => item.title)).toEqual([
      'Article 3',
      'Article 2',
      'Article 1',
    ]);
    expect(items.slice(3).map((item) => item.id)).toEqual(
      tied.map((item) => item.id).sort().reverse(),
    );
  });
});

describe('updateItem', () => {
  it('overwrites fields and maintains the `archived` index key', async () => {
    const item = await saveItem({ url: 'https://example.com/a', title: 'A' });
    const updated = await updateItem(item.id, { archived: true, tags: [' Rust ', 'rust'] });

    expect(updated.archived).toBe(true);
    expect(updated.archivedKey).toBe(1);
    expect(updated.tags).toEqual(['rust']);
    // Querying the index confirms the key really was updated.
    await expect(countArchived()).resolves.toBe(1);

    const back = await updateItem(item.id, { archived: false });
    expect(back.archivedKey).toBe(0);
    await expect(countArchived()).resolves.toBe(0);
  });

  it('throws for an unknown id', async () => {
    await expect(updateItem('no-such-id', { favorite: true })).rejects.toThrow(/no item/);
  });
});

describe('deleteItem', () => {
  it('deletes the item together with its content and highlights', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const other = await saveItem({ url: 'https://example.com/b' });

    await setContent(item.id, { html: '<p>content</p>', text: 'content' });
    await addHighlight({ itemId: item.id, text: 'one', start: 0, end: 3 });
    await addHighlight({ itemId: item.id, text: 'two', start: 4, end: 7 });
    await setContent(other.id, { html: '<p>other</p>', text: 'other' });
    await addHighlight({ itemId: other.id, text: 'alien', start: 0, end: 5 });

    // What comes back is the record as it was - the list holds it for Undo.
    const removed = await deleteItem(item.id);
    expect(removed?.item.id).toBe(item.id);
    expect(removed?.content?.text).toBe('content');
    // Order follows the index, not the order they were made in.
    expect(removed?.highlights.map((highlight) => highlight.text).sort()).toEqual(['one', 'two']);

    await expect(getItem(item.id)).resolves.toBeUndefined();
    await expect(getContent(item.id)).resolves.toBeUndefined();
    await expect(listHighlights(item.id)).resolves.toEqual([]);

    // The neighbouring item is untouched.
    await expect(getContent(other.id)).resolves.toBeDefined();
    await expect(listHighlights(other.id)).resolves.toHaveLength(1);
  });

  it('answers with null when there was nothing to delete', async () => {
    await expect(deleteItem('no-such-id')).resolves.toBeNull();
  });
});

describe('restoreItem', () => {
  it('puts back everything the deletion took, grave included', async () => {
    const item = await saveItem({ url: 'https://example.com/undo', title: 'Undo me' });
    await updateItem(item.id, { tags: ['rail'], favorite: true });
    await setContent(item.id, { html: '<p>content</p>', text: 'content' });
    await addHighlight({ itemId: item.id, text: 'one', start: 0, end: 3 });

    const removed = await deleteItem(item.id);
    if (removed === null) throw new Error('nothing was deleted');
    // The deletion left a grave behind; sync would otherwise carry it out
    // again on every device after the undo.
    await expect(listTombstones()).resolves.toHaveLength(1);

    await restoreItem(removed);

    const back = await getItem(item.id);
    expect(back?.title).toBe('Undo me');
    expect(back?.tags).toEqual(['rail']);
    expect(back?.favorite).toBe(true);
    await expect(getContent(item.id)).resolves.toMatchObject({ text: 'content' });
    await expect(listHighlights(item.id)).resolves.toHaveLength(1);
    await expect(listTombstones()).resolves.toEqual([]);
  });
});

describe('contents', () => {
  it('stores the content and marks the item ready in the same transaction', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    expect(item.status).toBe('pending');

    const content = await setContent(item.id, {
      html: '<p>sanitized</p>',
      text: 'sanitized',
      contentHash: 'sha256-abc',
    });

    expect(content.itemId).toBe(item.id);
    await expect(getContent(item.id)).resolves.toMatchObject({
      html: '<p>sanitized</p>',
      text: 'sanitized',
    });

    const refreshed = await getItem(item.id);
    expect(refreshed?.status).toBe('ready');
    expect(refreshed?.contentHash).toBe('sha256-abc');
  });

  it('does not store content for an unknown item', async () => {
    await expect(setContent('no-such-id', { html: '', text: '' })).rejects.toThrow(
      /no item/,
    );
    await expect(getContent('no-such-id')).resolves.toBeUndefined();
  });
});

describe('highlights', () => {
  it('adds and returns highlights by itemId, in insertion order', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const other = await saveItem({ url: 'https://example.com/b' });

    await addHighlight({ itemId: item.id, text: 'second', createdAt: 200, start: 10, end: 16 });
    await addHighlight({ itemId: item.id, text: 'first', createdAt: 100, note: 'a note', start: 0, end: 8 });
    await addHighlight({ itemId: other.id, text: 'alien', createdAt: 150, start: 0, end: 5 });

    const highlights = await listHighlights(item.id);
    expect(highlights.map((h) => h.text)).toEqual(['first', 'second']);
    expect(highlights[0]?.note).toBe('a note');
    expect(highlights[1]?.note).toBeNull();
  });

  it('does not add a highlight to an unknown item', async () => {
    await expect(addHighlight({ itemId: 'no-such-id', text: 'x', start: 0, end: 1 })).rejects.toThrow(
      /no item/,
    );
  });
});

describe('toggleItem', () => {
  it('flips what the database holds, not what the caller last saw', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    // Another context turned it on after this caller read `item`.
    await updateItem(item.id, { favorite: true });

    const toggled = await toggleItem(item.id, 'favorite');

    // Computing `!item.favorite` from the stale copy would have written `true` again.
    expect(toggled.favorite).toBe(false);
  });

  it('keeps the archive index key in step', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const archived = await toggleItem(item.id, 'archived');

    expect(archived.archived).toBe(true);
    expect(archived.archivedKey).toBe(1);
    expect(archived.updatedAt).toBeGreaterThanOrEqual(item.updatedAt);
  });

  it('throws for an item that is gone', async () => {
    await expect(toggleItem('no-such-id', 'favorite')).rejects.toThrow(/no item/);
  });
});

describe('migrations', () => {
  /** A record shaped as before version 2 - the types describe the present, not history. */
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
    // --- a version 1 database, records without the version 2 fields ---
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

    // --- the first use of the API raises the version to 2 ---
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

  /**
   * One past the current schema. Written relative to `DB_VERSION` so the next
   * real migration does not turn these tests into opening the database as it is.
   */
  const NEXT_VERSION = DB_VERSION + 1;

  /** A synthetic next version: we add a field to every item, deleting nothing. */
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

    // The data is still in place.
    await expect(countItems()).resolves.toBe(1);
  });
});

describe('exportAll', () => {
  it('returns a consistent dump of three stores, newest items first', async () => {
    const older = await saveItem({ url: 'https://a.example/1', savedAt: 1_000 });
    const newer = await saveItem({ url: 'https://b.example/2', savedAt: 2_000 });
    await setContent(older.id, { html: '<p>a</p>', text: 'a' });
    await addHighlight({ itemId: newer.id, text: 'a quote', start: 0, end: 7 });

    const dump = await exportAll();

    expect(dump.items.map((item) => item.url)).toEqual([
      'https://b.example/2',
      'https://a.example/1',
    ]);
    expect(dump.contents).toHaveLength(1);
    expect(dump.highlights).toHaveLength(1);
  });

  it('listAllItems gives metadata only, without content', async () => {
    const item = await saveItem({ url: 'https://a.example/1' });
    await setContent(item.id, { html: '<p>a</p>', text: 'a' });

    const items = await listAllItems();
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {})).not.toContain('html');
  });
});

describe('importDump', () => {
  /** A minimal item shaped like a record from a backup file. */
  function record(url: string, overrides: Partial<SavedItem> = {}): SavedItem {
    return {
      id: `file-${url}`,
      url: normalizeUrl(url),
      resolvedUrl: url,
      title: 'From the file',
      excerpt: '',
      byline: null,
      siteName: null,
      lang: null,
      wordCount: 100,
      estReadingMinutes: 1,
      savedAt: 1_000,
      updatedAt: 1_000,
      readAt: null,
      archived: false,
      favorite: false,
      tags: [],
      contentHash: null,
      status: 'ready',
      readingProgress: 0,
      archivedKey: 0,
      ...overrides,
    };
  }

  it('adds new items together with their content and highlights', async () => {
    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [
        { itemId: 'file-https://a.example/1', html: '<p>a</p>', text: 'a', updatedAt: 1_000 },
      ],
      highlights: [
        {
          id: 'h1',
          itemId: 'file-https://a.example/1',
          text: 'a quote',
          note: null,
          createdAt: 1_000,
          start: 0,
          end: 7,
          prefix: '',
          suffix: '',
        },
      ],
    });

    expect(outcome).toMatchObject({ added: 1, merged: 0, contents: 1, highlights: 1, skipped: 0 });

    const item = await getItemByUrl('https://a.example/1');
    expect(item).toBeDefined();
    expect((await getContent(item?.id ?? ''))?.html).toBe('<p>a</p>');
    expect(await listHighlights(item?.id ?? '')).toHaveLength(1);
  });

  it('merges by normalized address instead of duplicating', async () => {
    await saveItem({ url: 'https://a.example/1?utm_source=nl', tags: ['local'] });

    const outcome = await importDump({
      items: [record('https://a.example/1', { tags: ['from-file'] })],
      contents: [],
      highlights: [],
    });

    expect(outcome).toMatchObject({ added: 0, merged: 1 });
    expect(await countItems()).toBe(1);
    expect((await getItemByUrl('https://a.example/1'))?.tags).toEqual(['from-file', 'local']);
  });

  it('a merge adds but never takes away user state', async () => {
    const local = await saveItem({ url: 'https://a.example/1', title: 'Local title' });
    await updateItem(local.id, { archived: true, readAt: 5_000 });

    await importDump({
      items: [
        record('https://a.example/1', {
          title: 'Title from the file',
          archived: false,
          favorite: true,
          readAt: null,
          savedAt: 500,
        }),
      ],
      contents: [],
      highlights: [],
    });

    const merged = await getItem(local.id);
    // The state on this side stays; the file only adds what was missing.
    expect(merged?.archived).toBe(true);
    expect(merged?.readAt).toBe(5_000);
    expect(merged?.title).toBe('Local title');
    expect(merged?.favorite).toBe(true);
    expect(merged?.savedAt).toBe(500);
  });

  it('does not overwrite content we already have, and counts it as skipped', async () => {
    const local = await saveItem({ url: 'https://a.example/1' });
    await setContent(local.id, { html: '<p>local</p>', text: 'local' });

    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [
        { itemId: 'file-https://a.example/1', html: '<p>from the file</p>', text: 'x', updatedAt: 9_000 },
      ],
      highlights: [],
    });

    expect(outcome.contents).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect((await getContent(local.id))?.html).toBe('<p>local</p>');
  });

  it('does not duplicate highlights with the same quote and offsets', async () => {
    const local = await saveItem({ url: 'https://a.example/1' });
    await addHighlight({ itemId: local.id, text: 'a quote', start: 0, end: 7 });

    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [],
      highlights: [
        {
          id: 'another-id',
          itemId: 'file-https://a.example/1',
          text: 'a quote',
          note: null,
          createdAt: 1_000,
          start: 0,
          end: 7,
          prefix: '',
          suffix: '',
        },
      ],
    });

    expect(outcome.highlights).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(await listHighlights(local.id)).toHaveLength(1);
  });

  it('an identifier collision does not overwrite another item', async () => {
    const local = await saveItem({ url: 'https://a.example/old' });

    await importDump({
      items: [record('https://b.example/new', { id: local.id })],
      contents: [],
      highlights: [],
    });

    expect(await countItems()).toBe(2);
    expect((await getItem(local.id))?.url).toBe('https://a.example/old');
    expect(await getItemByUrl('https://b.example/new')).toBeDefined();
  });

  it('a failure halfway leaves no half-import behind', async () => {
    // A record with a field the structured clone will not accept - the
    // transaction has to roll back together with the items written before it.
    const poisoned = record('https://c.example/3') as SavedItem & { bad?: unknown };
    poisoned.bad = () => undefined;

    await expect(
      importDump({
        items: [record('https://a.example/1'), record('https://b.example/2'), poisoned],
        contents: [],
        highlights: [],
      }),
    ).rejects.toThrow();

    expect(await countItems()).toBe(0);
  });
});

describe('snapshots', () => {
  it('copy the metadata and keep only the last SNAPSHOT_LIMIT', async () => {
    await saveItem({ url: 'https://a.example/1' });

    for (let i = 0; i < SNAPSHOT_LIMIT + 2; i += 1) {
      await createSnapshot(10_000 + i);
    }

    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(SNAPSHOT_LIMIT);
    // The newest on top, the oldest pushed out.
    expect(snapshots[0]?.createdAt).toBe(10_000 + SNAPSHOT_LIMIT + 1);
    expect(snapshots[0]?.itemCount).toBe(1);
  });

  it('the daily backup does not repeat more often than SNAPSHOT_INTERVAL_MS', async () => {
    await saveItem({ url: 'https://a.example/1' });
    const now = 1_000_000_000;

    expect(await createSnapshotIfDue(now)).not.toBeNull();
    expect(await createSnapshotIfDue(now + 60_000)).toBeNull();
    expect(await createSnapshotIfDue(now + SNAPSHOT_INTERVAL_MS + 1)).not.toBeNull();
    expect(await listSnapshots()).toHaveLength(2);
  });

  it('an empty database does not deserve a backup', async () => {
    expect(await createSnapshotIfDue(1_000)).toBeNull();
    expect(await listSnapshots()).toHaveLength(0);
  });

  it('a restore adds back deleted items and leaves the rest alone', async () => {
    const deleted = await saveItem({ url: 'https://a.example/1', tags: ['rust'] });
    await saveItem({ url: 'https://b.example/2' });
    await createSnapshot(10_000);

    await deleteItem(deleted.id);
    const later = await saveItem({ url: 'https://c.example/3' });

    const [snapshot] = await listSnapshots();
    const outcome = await restoreSnapshot(snapshot?.id ?? '');

    expect(outcome).toMatchObject({ added: 1, merged: 1 });
    expect((await getItemByUrl('https://a.example/1'))?.tags).toEqual(['rust']);
    // The backup is older than this item - restoring must not touch it.
    expect(await getItem(later.id)).toBeDefined();
    expect(await countItems()).toBe(3);
  });

  it('restoring a nonexistent backup is an error, not a silent failure', async () => {
    await expect(restoreSnapshot('no-such-backup')).rejects.toThrow(/no backup/);
  });
});

describe('dataStats and clearAllData', () => {
  it('count what the options page shows', async () => {
    const first = await saveItem({ url: 'https://a.example/1' });
    const second = await saveItem({ url: 'https://b.example/2' });
    await setContent(first.id, { html: '<p>a</p>', text: 'a' });
    await addHighlight({ itemId: first.id, text: 'a quote', start: 0, end: 7 });
    await updateItem(second.id, { archived: true, favorite: true, readAt: 1_000 });
    await createSnapshot(10_000);

    expect(await dataStats()).toEqual({
      items: 2,
      unread: 1,
      archived: 1,
      favorite: 1,
      contents: 1,
      highlights: 1,
      snapshots: 1,
    });
  });

  it('wiping clears everything and the database keeps working', async () => {
    const item = await saveItem({ url: 'https://a.example/1' });
    await setContent(item.id, { html: '<p>a</p>', text: 'a' });
    await createSnapshot(10_000);

    await clearAllData();

    expect(await dataStats()).toMatchObject({ items: 0, contents: 0, snapshots: 0 });
    await expect(saveItem({ url: 'https://b.example/2' })).resolves.toBeDefined();
  });
});

describe('applySync', () => {
  it('keeps the id of every highlight that survives, so an open reader still points at it', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const kept = await addHighlight({ itemId: item.id, text: 'kept', start: 0, end: 4 });
    await addHighlight({ itemId: item.id, text: 'gone', start: 5, end: 9 });

    const { id: _id, archivedKey: _key, ...fields } = item;
    await applySync({
      writes: [
        {
          item: fields,
          content: null,
          highlights: [
            {
              text: 'kept',
              note: 'a note from the other side',
              createdAt: kept.createdAt,
              start: 0,
              end: 4,
              prefix: '',
              suffix: '',
            },
            { text: 'new', note: null, createdAt: 1, start: 10, end: 13, prefix: '', suffix: '' },
          ],
        },
      ],
      deleteUrls: [],
      tombstones: [],
    });

    const after = await listHighlights(item.id);
    expect(after.map((entry) => entry.text).sort()).toEqual(['kept', 'new']);
    expect(after.find((entry) => entry.text === 'kept')).toMatchObject({
      id: kept.id,
      note: 'a note from the other side',
    });
  });
});
