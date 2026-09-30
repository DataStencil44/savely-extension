import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addHighlight,
  deleteDb,
  deleteItem,
  getContent,
  getItem,
  getItemByUrl,
  listAllItems,
  listHighlights,
  listTombstones,
  openDb,
  restoreItem,
  saveItem,
  setContent,
  toggleItem,
  updateItem,
} from './index';

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

    expect(second.title).toBe('New title');
    expect(second.wordCount).toBe(800);
    expect(second.estReadingMinutes).toBe(4);
    expect(second.savedAt).toBe(5_000);

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

    const removed = await deleteItem(item.id);
    expect(removed?.item.id).toBe(item.id);
    expect(removed?.content?.text).toBe('content');
    expect(removed?.highlights.map((highlight) => highlight.text).sort()).toEqual(['one', 'two']);

    await expect(getItem(item.id)).resolves.toBeUndefined();
    await expect(getContent(item.id)).resolves.toBeUndefined();
    await expect(listHighlights(item.id)).resolves.toEqual([]);

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

describe('toggleItem', () => {
  it('flips what the database holds, not what the caller last saw', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    await updateItem(item.id, { favorite: true });

    const toggled = await toggleItem(item.id, 'favorite');

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
