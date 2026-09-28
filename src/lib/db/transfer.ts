/**
 * Moving data in bulk: the export dump, the import merge, the automatic
 * metadata backups, the counters and "delete everything".
 */
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

/** The full database contents without snapshots - what goes into a backup file. */
export interface DatabaseDump {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
}

/** What happened during a merge. The numbers go straight into the options report. */
export interface MergeOutcome {
  /** Items that did not exist before. */
  added: number;
  /** Items recognized by their normalized address and filled in. */
  merged: number;
  contents: number;
  highlights: number;
  /** Records skipped at the database level (content with no item, say). */
  skipped: number;
}

const EMPTY_OUTCOME: MergeOutcome = {
  added: 0,
  merged: 0,
  contents: 0,
  highlights: 0,
  skipped: 0,
};

/**
 * The whole dump in one read-only transaction, so an export is a consistent
 * picture of the database rather than three reads from three different moments.
 */
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

/**
 * Merges an imported item into an existing one.
 *
 * The rule: user state on this side outweighs the file. An import may ADD
 * (tags, missing metadata, an earlier save date, a favorite), but may not take
 * away - it does not un-archive, does not drop tags, does not undo a read.
 * Otherwise restoring an old backup would undo current work.
 */
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
    // The save date is a historical fact - the earlier one wins.
    savedAt: Math.min(existing.savedAt, incoming.savedAt),
    // A merge is a local change - it should travel on at the next sync.
    updatedAt: Date.now(),
    readAt: existing.readAt ?? incoming.readAt,
    favorite: existing.favorite || incoming.favorite,
    tags: normalizeTags([...existing.tags, ...incoming.tags]),
    readingProgress: Math.max(existing.readingProgress, incoming.readingProgress),
  });
}

/** Two highlights with the same quote and offsets are the same highlight. */
function sameHighlight(a: Highlight, b: Highlight): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end;
}

/**
 * Writes a dump into the database in ONE transaction: either all of it lands or
 * none. A failure halfway through (running out of space, say) rolls everything
 * back - we never leave half an import or content without an item.
 *
 * The records must already be validated (see `src/lib/backup.ts`); here we
 * guard only database consistency: deduplication by address, identifier
 * collisions and orphans in `contents`/`highlights`.
 */
export async function importDump(dump: DatabaseDump): Promise<MergeOutcome> {
  if (dump.items.length === 0 && dump.contents.length === 0 && dump.highlights.length === 0) {
    return { ...EMPTY_OUTCOME };
  }

  return writeAtomically(['items', 'contents', 'highlights'], (tx) => writeDump(tx, dump));
}

/** The actual merge. Called only from `importDump`, inside its transaction. */
async function writeDump(
  tx: IDBPTransaction<SavelyDB, ('items' | 'contents' | 'highlights')[], 'readwrite'>,
  dump: DatabaseDump,
): Promise<MergeOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const highlights = tx.objectStore('highlights');

  const outcome: MergeOutcome = { ...EMPTY_OUTCOME };
  /** id from the file -> id in the database; content and highlights are mapped through it. */
  const target = new Map<string, string>();

  for (const incoming of dump.items) {
    const existing = await items.index('url').get(incoming.url);

    if (existing !== undefined) {
      await items.put(mergeImported(existing, incoming));
      target.set(incoming.id, existing.id);
      outcome.merged += 1;
      continue;
    }

    // An identifier from the file may already belong to a DIFFERENT item -
    // writing under that key would overwrite someone else's record. In that
    // case we take a fresh id.
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
    // Local content is fresher by definition - an import does not overwrite it.
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

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

/** How many backups we keep. The fourth pushes out the oldest. */
export const SNAPSHOT_LIMIT = 3;

/**
 * The gap between automatic backups. Shorter than a day, because the alarm can
 * fire late, and a missed day hurts more than a backup taken after twenty
 * hours.
 */
export const SNAPSHOT_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** A metadata backup + trimming to `SNAPSHOT_LIMIT`, in one transaction. */
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

  // Keys from the `createdAt` index run oldest-first - the excess is cut off the front.
  const byAge = await snapshots.index('createdAt').getAllKeys();
  for (const key of byAge.slice(0, Math.max(0, byAge.length - SNAPSHOT_LIMIT))) {
    await snapshots.delete(key);
  }

  await tx.done;
  return snapshot;
}

/**
 * The daily backup. `null` when there is nothing to back up or the last one is
 * still fresh - the alarm can fire more than once a day (a wake-up, a
 * reinstall).
 */
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

/** Backup summaries, newest first. Without `items` - see `SnapshotSummary`. */
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

/**
 * Restores a backup through the same merge as an import: it adds missing items
 * and fills in existing ones, but deletes nothing. Restoring a backup must not
 * take away what arrived after it was made.
 */
export async function restoreSnapshot(id: string): Promise<MergeOutcome> {
  const snapshot = await getSnapshot(id);
  if (snapshot === undefined) throw new Error(`There is no backup with id ${id}.`);
  return importDump({ items: snapshot.items, contents: [], highlights: [] });
}

// ---------------------------------------------------------------------------
// Statistics and wiping
// ---------------------------------------------------------------------------

export interface DataStats {
  items: number;
  unread: number;
  archived: number;
  favorite: number;
  contents: number;
  highlights: number;
  snapshots: number;
}

/** Counters for the options page. One pass over `items`, the rest from `count()`. */
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

/**
 * "Delete all data" - we drop the whole database instead of clearing the stores
 * one by one. That also removes anything this code might forget about.
 */
export async function clearAllData(): Promise<void> {
  await deleteDb();
}
