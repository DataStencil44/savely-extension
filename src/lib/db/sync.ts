/**
 * Sync's side of the database: reading the local state, writing what the merge
 * decided, and the base the next merge compares against.
 *
 * The merging itself lives in `src/lib/sync/merge.ts` - here we only write what
 * it decided, plus the address -> local `id` mapping.
 */
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

/**
 * The local state in the shape it is compared against the remote one.
 *
 * The key is the **normalized address**, not `id`: identifiers are local to a
 * device and will never match across the two sides of a sync.
 */
export interface SyncLocalState {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
  tombstones: Tombstone[];
  /** What this device last pushed; empty before the first push. */
  base: SyncBaseEntry[];
}

/** One item to write after the merge. `null` = that part is unchanged. */
export interface SyncItemWrite {
  /** `id` and `archivedKey` are set by the database - the rest comes from the merge. */
  item: Omit<SavedItem, 'id' | 'archivedKey'>;
  content: { html: string; text: string; updatedAt: number } | null;
  /** The complete, merged set of this item's highlights. */
  highlights: Omit<Highlight, 'id' | 'itemId'>[] | null;
}

export interface SyncWritePlan {
  writes: SyncItemWrite[];
  /** Addresses of items that disappeared on the other side (the tombstone is newer). */
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

/** All the state a merge needs, in one read-only transaction. */
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

/**
 * Replaces the base with what was just pushed. Called only **after** the push
 * went through: a base ahead of the remote would read the remote's missing
 * entries as removals and drop what this device just added.
 */
export async function saveSyncBase(entries: readonly SyncBaseEntry[]): Promise<void> {
  await writeAtomically(['syncBase'], async (tx) => {
    const store = tx.objectStore('syncBase');
    await store.clear();
    for (const entry of entries) await store.put(entry);
  });
}

/**
 * Forgets the base. A base describes one particular remote; measured against a
 * different one, everything it lacks would look deliberately removed.
 */
export async function clearSyncBase(): Promise<void> {
  const db = await openDb();
  await db.clear('syncBase');
}

/**
 * Writes the merge result. One transaction across four stores: an interruption
 * halfway rolls everything back, so the database is never left "half synced"
 * (the same rule as for an import).
 */
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

/** A highlight's identity across devices: the quote plus the offsets. */
function highlightKey(highlight: Pick<Highlight, 'text' | 'start' | 'end'>): string {
  return `${highlight.text}\u0000${String(highlight.start)}\u0000${String(highlight.end)}`;
}

/**
 * Makes an item's highlights exactly `merged`, keeping the id of every
 * highlight that survives. A reader open on the item holds those ids - handing
 * out new ones on every sync would leave its delete and note buttons pointing
 * at rows that no longer exist.
 */
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

    // The merged set goes in whole: `merge` returns it only when it differs
    // from the local one, so nothing moves here without a reason.
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
