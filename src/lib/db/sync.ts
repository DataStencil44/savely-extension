import type { IDBPTransaction } from 'idb';

import {
  openDb,
  removeItemRecords,
  withDerived,
  writeAtomically,
  type Highlight,
  type ItemContent,
  type SavedItem,
  type SavelyDB,
  type SyncBaseEntry,
  type Tombstone,
} from './schema';

export interface SyncLocalState {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
  tombstones: Tombstone[];
  base: SyncBaseEntry[];
}

export interface SyncItemWrite {
  item: Omit<SavedItem, 'id' | 'archivedKey'>;
  content: { html: string; text: string; updatedAt: number } | null;
  highlights: Omit<Highlight, 'id' | 'itemId'>[] | null;
}

export interface SyncWritePlan {
  writes: SyncItemWrite[];
  deleteUrls: string[];
  tombstones: Tombstone[];
}

export interface SyncWriteOutcome {
  added: number;
  updated: number;
  deleted: number;
  contents: number;
  highlights: number;
}

export async function collectForSync(): Promise<SyncLocalState> {
  const db = await openDb();
  const tx = db.transaction(
    ['items', 'contents', 'highlights', 'tombstones', 'syncBase'],
    'readonly',
  );
  const state: SyncLocalState = {
    items: await tx.objectStore('items').getAll(),
    contents: await tx.objectStore('contents').getAll(),
    highlights: await tx.objectStore('highlights').getAll(),
    tombstones: await tx.objectStore('tombstones').getAll(),
    base: await tx.objectStore('syncBase').getAll(),
  };
  await tx.done;
  return state;
}

export async function listTombstones(): Promise<Tombstone[]> {
  const db = await openDb();
  return db.getAll('tombstones');
}

export async function saveSyncBase(entries: readonly SyncBaseEntry[]): Promise<void> {
  await writeAtomically(['syncBase'], async (tx) => {
    const store = tx.objectStore('syncBase');
    await store.clear();
    for (const entry of entries) await store.put(entry);
  });
}

export async function clearSyncBase(): Promise<void> {
  const db = await openDb();
  await db.clear('syncBase');
}

export async function applySync(plan: SyncWritePlan): Promise<SyncWriteOutcome> {
  return writeAtomically(['items', 'contents', 'highlights', 'tombstones'], (tx) =>
    writeSync(tx, plan),
  );
}

type SyncTransaction = IDBPTransaction<
  SavelyDB,
  ('items' | 'contents' | 'highlights' | 'tombstones')[],
  'readwrite'
>;

function highlightKey(highlight: Pick<Highlight, 'text' | 'start' | 'end'>): string {
  return `${highlight.text}\u0000${String(highlight.start)}\u0000${String(highlight.end)}`;
}

async function replaceHighlights(
  tx: SyncTransaction,
  itemId: string,
  merged: readonly Omit<Highlight, 'id' | 'itemId'>[],
): Promise<number> {
  const store = tx.objectStore('highlights');
  const existing = new Map<string, string>();
  let cursor = await store.index('itemId').openCursor(IDBKeyRange.only(itemId));
  while (cursor !== null) {
    existing.set(highlightKey(cursor.value), cursor.value.id);
    cursor = await cursor.continue();
  }

  const kept = new Set<string>();
  for (const highlight of merged) {
    const key = highlightKey(highlight);
    const id = existing.get(key) ?? crypto.randomUUID();
    kept.add(key);
    await store.put({ ...highlight, id, itemId });
  }
  for (const [key, id] of existing) {
    if (!kept.has(key)) await store.delete(id);
  }
  return merged.length;
}

async function writeSync(tx: SyncTransaction, plan: SyncWritePlan): Promise<SyncWriteOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const tombstones = tx.objectStore('tombstones');

  const outcome: SyncWriteOutcome = {
    added: 0,
    updated: 0,
    deleted: 0,
    contents: 0,
    highlights: 0,
  };

  for (const write of plan.writes) {
    const existing = await items.index('url').get(write.item.url);
    const id = existing?.id ?? crypto.randomUUID();

    await items.put(withDerived({ ...write.item, id }));
    if (existing === undefined) outcome.added += 1;
    else outcome.updated += 1;

    if (write.content !== null) {
      await contents.put({ itemId: id, ...write.content });
      outcome.contents += 1;
    }

    if (write.highlights !== null) {
      outcome.highlights += await replaceHighlights(tx, id, write.highlights);
    }
  }

  for (const url of plan.deleteUrls) {
    const existing = await items.index('url').get(url);
    if (existing === undefined) continue;

    await removeItemRecords(tx, existing.id);
    outcome.deleted += 1;
  }

  for (const tombstone of plan.tombstones) {
    const known = await tombstones.get(tombstone.url);
    if (known === undefined || known.deletedAt < tombstone.deletedAt) {
      await tombstones.put(tombstone);
    }
  }

  return outcome;
}
