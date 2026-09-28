/**
 * The database as the pages see it: every write tells the other open contexts
 * that the data changed (CLAUDE.md 4.12).
 *
 * The announcement used to be the caller's job, one `announceChange()` after
 * each write in each page, and the writes that forgot (a highlight, a deleted
 * note) left another tab showing the old state. Here a write and its
 * announcement are one call, and the pages may not import `@/lib/db` at all
 * (ESLint), so there is no write left to forget.
 *
 * `db` stays free of `browser.*`: it is tested on its own and runs in the
 * background, where the save path announces once for a save that is two
 * writes.
 */
import { announceChange } from './changes';
import * as db from './db';

/** The write, then the announcement - only once the write has landed. */
function announced<Args extends unknown[], Result>(
  write: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const result = await write(...args);
    announceChange();
    return result;
  };
}

// Items
export const updateItem = announced(db.updateItem);
export const toggleItem = announced(db.toggleItem);
export const deleteItem = announced(db.deleteItem);
export const restoreItem = announced(db.restoreItem);

/**
 * The one write that stays quiet. The reader stores the scroll position every
 * second or so while someone reads, and an announcement each time would have
 * every open list re-read the whole library for a number none of them shows.
 */
export async function saveReadingProgress(id: string, progress: number): Promise<void> {
  await db.updateItem(id, { readingProgress: progress });
}

// Highlights
export const addHighlight = announced(db.addHighlight);
export const updateHighlight = announced(db.updateHighlight);
export const deleteHighlight = announced(db.deleteHighlight);

// Moving data in bulk
export const importDump = announced(db.importDump);
export const restoreSnapshot = announced(db.restoreSnapshot);
export const clearAllData = announced(db.clearAllData);

// Reads, and writes nothing else is showing
export {
  DB_VERSION,
  SNAPSHOT_LIMIT,
  createSnapshot,
  dataStats,
  exportAll,
  getContent,
  getContents,
  getItem,
  listAllItems,
  listContentIds,
  listFavicons,
  listHighlights,
  listSnapshots,
  type Highlight,
  type ItemFlag,
  type MergeOutcome,
  type RemovedItem,
  type SavedItem,
} from './db';
