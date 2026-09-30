import { announceChange } from './changes';
import * as db from './db';

function announced<Args extends unknown[], Result>(
  write: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    const result = await write(...args);
    announceChange();
    return result;
  };
}

export const updateItem = announced(db.updateItem);
export const toggleItem = announced(db.toggleItem);
export const deleteItem = announced(db.deleteItem);
export const restoreItem = announced(db.restoreItem);

export async function saveReadingProgress(id: string, progress: number): Promise<void> {
  await db.updateItem(id, { readingProgress: progress });
}

export const addHighlight = announced(db.addHighlight);
export const updateHighlight = announced(db.updateHighlight);
export const deleteHighlight = announced(db.deleteHighlight);

export const importDump = announced(db.importDump);
export const restoreSnapshot = announced(db.restoreSnapshot);
export const clearAllData = announced(db.clearAllData);

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
