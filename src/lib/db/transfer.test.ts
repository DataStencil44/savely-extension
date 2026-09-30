import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LIMIT,
  addHighlight,
  clearAllData,
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
  openDb,
  restoreSnapshot,
  saveItem,
  setContent,
  updateItem,
  type SavedItem,
} from './index';
import { normalizeUrl } from '../url';

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
