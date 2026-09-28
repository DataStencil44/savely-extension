/**
 * The storage layer: IndexedDB through `idb`, one module per subject. See
 * `schema.ts` for the stores and why each exists.
 *
 * IndexedDB is the single source of truth for data (CLAUDE.md 4.3);
 * `storage.local` is left for small UI settings.
 *
 * Pages do not import this directly - they go through `src/lib/library.ts`,
 * which tells the other open pages about every write.
 */
export {
  DB_NAME,
  DB_VERSION,
  closeDb,
  deleteDb,
  openDb,
  type Highlight,
  type ItemContent,
  type ItemStatus,
  type Migration,
  type OpenDbOptions,
  type SavedItem,
  type SavelyDB,
  type SiteIcon,
  type Snapshot,
  type SnapshotSummary,
  type SyncBaseEntry,
  type Tombstone,
} from './schema';
export * from './items';
export * from './content';
export * from './highlights';
export * from './transfer';
export * from './sync';
