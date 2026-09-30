import type { IDBPTransaction } from 'idb';

import { normalizeTags } from '../url';

import {
  deleteDb,
  openDb,
  withDerived,
  writeAtomically,
  type Highlight,
  type ItemContent,
  type SavedItem,
  type SavelyDB,
  type Snapshot,
  type SnapshotSummary,
} from './schema';

export interface DatabaseDump {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
}

export interface MergeOutcome {
  added: number;
  merged: number;
  contents: number;
  highlights: number;
  skipped: number;
}

const EMPTY_OUTCOME: MergeOutcome = {
  added: 0,
  merged: 0,
  contents: 0,
  highlights: 0,
  skipped: 0,
};

export async function exportAll(): Promise<DatabaseDump> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readonly');
  const items = await tx.objectStore('items').getAll();
  const contents = await tx.objectStore('contents').getAll();
  const highlights = await tx.objectStore('highlights').getAll();
  await tx.done;

  items.sort((a, b) => b.savedAt - a.savedAt);
  return { items, contents, highlights };
}

function mergeImported(existing: SavedItem, incoming: SavedItem): SavedItem {
  const wordCount = existing.wordCount === 0 ? incoming.wordCount : existing.wordCount;

  return withDerived({
    ...existing,
    title: existing.title === '' ? incoming.title : existing.title,
    excerpt: existing.excerpt === '' ? incoming.excerpt : existing.excerpt,
    byline: existing.byline ?? incoming.byline,
    siteName: existing.siteName ?? incoming.siteName,
    lang: existing.lang ?? incoming.lang,
    wordCount,
    estReadingMinutes:
      existing.estReadingMinutes === 0 ? incoming.estReadingMinutes : existing.estReadingMinutes,
    savedAt: Math.min(existing.savedAt, incoming.savedAt),
    updatedAt: Date.now(),
    readAt: existing.readAt ?? incoming.readAt,
    favorite: existing.favorite || incoming.favorite,
    tags: normalizeTags([...existing.tags, ...incoming.tags]),
    readingProgress: Math.max(existing.readingProgress, incoming.readingProgress),
  });
}

function sameHighlight(a: Highlight, b: Highlight): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end;
}

export async function importDump(dump: DatabaseDump): Promise<MergeOutcome> {
  if (dump.items.length === 0 && dump.contents.length === 0 && dump.highlights.length === 0) {
    return { ...EMPTY_OUTCOME };
  }

  return writeAtomically(['items', 'contents', 'highlights'], (tx) => writeDump(tx, dump));
}

async function writeDump(
  tx: IDBPTransaction<SavelyDB, ('items' | 'contents' | 'highlights')[], 'readwrite'>,
  dump: DatabaseDump,
): Promise<MergeOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const highlights = tx.objectStore('highlights');

  const outcome: MergeOutcome = { ...EMPTY_OUTCOME };
  const target = new Map<string, string>();

  for (const incoming of dump.items) {
    const existing = await items.index('url').get(incoming.url);

    if (existing !== undefined) {
      await items.put(mergeImported(existing, incoming));
      target.set(incoming.id, existing.id);
      outcome.merged += 1;
      continue;
    }

    const collision = await items.get(incoming.id);
    const id = collision === undefined ? incoming.id : crypto.randomUUID();

    await items.put(withDerived({ ...incoming, id }));
    target.set(incoming.id, id);
    outcome.added += 1;
  }

  for (const content of dump.contents) {
    const id = target.get(content.itemId);
    if (id === undefined) {
      outcome.skipped += 1;
      continue;
    }
    if ((await contents.get(id)) !== undefined) {
      outcome.skipped += 1;
      continue;
    }
    await contents.put({ ...content, itemId: id });
    outcome.contents += 1;
  }

  for (const highlight of dump.highlights) {
    const id = target.get(highlight.itemId);
    if (id === undefined) {
      outcome.skipped += 1;
      continue;
    }

    const mine = await highlights.index('itemId').getAll(IDBKeyRange.only(id));
    if (mine.some((entry) => sameHighlight(entry, highlight))) {
      outcome.skipped += 1;
      continue;
    }

    const collision = await highlights.get(highlight.id);
    await highlights.put({
      ...highlight,
      id: collision === undefined ? highlight.id : crypto.randomUUID(),
      itemId: id,
    });
    outcome.highlights += 1;
  }

  return outcome;
}

export const SNAPSHOT_LIMIT = 3;

export const SNAPSHOT_INTERVAL_MS = 20 * 60 * 60 * 1000;

export async function createSnapshot(now = Date.now()): Promise<Snapshot> {
  const db = await openDb();
  const tx = db.transaction(['items', 'snapshots'], 'readwrite');
  const items = await tx.objectStore('items').getAll();

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: now,
    itemCount: items.length,
    items,
  };

  const snapshots = tx.objectStore('snapshots');
  await snapshots.put(snapshot);

  const byAge = await snapshots.index('createdAt').getAllKeys();
  for (const key of byAge.slice(0, Math.max(0, byAge.length - SNAPSHOT_LIMIT))) {
    await snapshots.delete(key);
  }

  await tx.done;
  return snapshot;
}

export async function createSnapshotIfDue(now = Date.now()): Promise<Snapshot | null> {
  const db = await openDb();
  if ((await db.count('items')) === 0) return null;

  const [fresh] = await db.getAllFromIndex(
    'snapshots',
    'createdAt',
    IDBKeyRange.lowerBound(now - SNAPSHOT_INTERVAL_MS),
    1,
  );
  if (fresh !== undefined) return null;

  return createSnapshot(now);
}

export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const db = await openDb();
  const snapshots = await db.getAll('snapshots');
  return snapshots
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, createdAt, itemCount }) => ({ id, createdAt, itemCount }));
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const db = await openDb();
  return db.get('snapshots', id);
}

export async function restoreSnapshot(id: string): Promise<MergeOutcome> {
  const snapshot = await getSnapshot(id);
  if (snapshot === undefined) throw new Error(`There is no backup with id ${id}.`);
  return importDump({ items: snapshot.items, contents: [], highlights: [] });
}

export interface DataStats {
  items: number;
  unread: number;
  archived: number;
  favorite: number;
  contents: number;
  highlights: number;
  snapshots: number;
}

export async function dataStats(): Promise<DataStats> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'snapshots'], 'readonly');

  const stats: DataStats = {
    items: 0,
    unread: 0,
    archived: 0,
    favorite: 0,
    contents: await tx.objectStore('contents').count(),
    highlights: await tx.objectStore('highlights').count(),
    snapshots: await tx.objectStore('snapshots').count(),
  };

  let cursor = await tx.objectStore('items').openCursor();
  while (cursor !== null) {
    const item = cursor.value;
    stats.items += 1;
    if (item.readAt === null) stats.unread += 1;
    if (item.archived) stats.archived += 1;
    if (item.favorite) stats.favorite += 1;
    cursor = await cursor.continue();
  }

  await tx.done;
  return stats;
}

export async function clearAllData(): Promise<void> {
  await deleteDb();
}
