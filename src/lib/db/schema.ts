/**
 * The storage layer: the schema, its migrations and the connection. The
 * operations on each store live next to this file, one subject per file.
 *
 * The `savely` database, seven stores:
 *   items      - item metadata (light, loaded into the list)
 *   contents   - sanitized HTML + plain text, kept apart on purpose:
 *                the list must not pull in megabytes of content just to open
 *   highlights - selections inside the content, linked by itemId
 *   snapshots  - automatic backups of METADATA (no content), the last three
 *   tombstones - traces of deleted items, for sync
 *   favicons   - one site icon per domain, as bytes, so the list draws
 *                something without going to the network
 *   syncBase   - the tags and highlights both sides of a sync last agreed
 *                on, so the next merge can tell a removal from an addition
 *
 * IndexedDB is the single source of truth for data (CLAUDE.md 4.3);
 * `storage.local` is left for small UI settings.
 */
import {
  openDB,
  deleteDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ItemStatus = 'pending' | 'ready' | 'failed';

export interface SavedItem {
  id: string;
  /**
   * The normalized address (without tracking parameters) - the deduplication
   * key and the unique `url` index.
   */
  url: string;
  /** The original address, exactly as it came from the tab. */
  resolvedUrl: string;
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  wordCount: number;
  estReadingMinutes: number;
  savedAt: number;
  /**
   * The last change to anything in this record. Set by **every** write path -
   * sync resolves conflicts by it (whoever wrote later wins), so a stale value
   * means the change is lost at the next merge.
   */
  updatedAt: number;
  readAt: number | null;
  archived: boolean;
  favorite: boolean;
  tags: string[];
  contentHash: string | null;
  status: ItemStatus;
  /** How far the article was scrolled, 0..1. The reader writes it, the list may show it. */
  readingProgress: number;
  /**
   * Derived from `archived` (0/1). IndexedDB does not index booleans - records
   * keyed `false`/`true` would simply never reach the index. Maintained
   * automatically by every write path; do not set it by hand.
   */
  archivedKey: 0 | 1;
}

export interface ItemContent {
  itemId: string;
  /** HTML after DOMPurify - never raw HTML from the page. */
  html: string;
  /** The same content as plain text; the source for the search index. */
  text: string;
  updatedAt: number;
}

/**
 * A selection anchored in the **text**, not in the HTML structure.
 *
 * `start`/`end` are offsets into the article's plain text, and `prefix`/`suffix`
 * are a few dozen characters of context. When the content shifts slightly
 * (different paragraph splits, an excerpt glued on), the offsets stop matching,
 * but the quote plus its context still locate the spot - which an XPath would
 * not survive.
 */
export interface Highlight {
  id: string;
  itemId: string;
  /** The selected text - both what to restore and what to copy. */
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

/**
 * An automatic metadata backup. Deliberately WITHOUT `contents` - article
 * bodies are megabytes, and three copies of them in the same database would eat
 * the disk quota faster than anything else. A snapshot rescues what re-saving
 * the page cannot recreate: tags, favorites, archive state, dates.
 */
export interface Snapshot {
  id: string;
  createdAt: number;
  itemCount: number;
  items: SavedItem[];
}

/** A row in the backup list - without `items`, so the UI does not pull in the whole database. */
export type SnapshotSummary = Omit<Snapshot, 'items'>;

/**
 * A trace of a deleted item. Without it sync would be one-way: an item deleted
 * on one device would come back from another at the next merge. The key is the
 * normalized address, because `id` differs between devices.
 */
export interface Tombstone {
  url: string;
  deletedAt: number;
}

/**
 * A site icon, keyed by domain (hostname without `www.`) - one row serves every
 * item saved from that site. The value is a `data:` URL, so the list needs no
 * network. A cache, not user data: it is rebuilt by the next save, stays out of
 * exports and out of sync, and losing it costs a picture.
 */
export interface SiteIcon {
  domain: string;
  /** `data:image/...;base64,...` - written only by `putFavicon`. */
  dataUrl: string;
  updatedAt: number;
}

/**
 * What one item looked like, as far as tags and highlights go, in the last
 * payload this device pushed - the state both sides last agreed on.
 *
 * Without it a merge sees a tag on one side and not the other and cannot tell
 * "added there" from "removed here", so it could only ever add: a removed tag,
 * a deleted highlight or a cleared note came back at the next sync. With it the
 * merge compares each side against the base (`src/lib/sync/merge.ts`).
 */
export interface SyncBaseEntry {
  url: string;
  tags: string[];
  highlights: {
    text: string;
    note: string | null;
    start: number;
    end: number;
  }[];
}

export interface SavelyDB extends DBSchema {
  items: {
    key: string;
    value: SavedItem;
    indexes: {
      savedAt: number;
      /** keyPath: `archivedKey` - see the comment on the field. */
      archived: number;
      url: string;
      tags: string;
    };
  };
  contents: {
    key: string;
    value: ItemContent;
  };
  highlights: {
    key: string;
    value: Highlight;
    indexes: { itemId: string };
  };
  snapshots: {
    key: string;
    value: Snapshot;
    indexes: { createdAt: number };
  };
  tombstones: {
    key: string;
    value: Tombstone;
  };
  favicons: {
    key: string;
    value: SiteIcon;
  };
  syncBase: {
    key: string;
    value: SyncBaseEntry;
  };
}

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

export const DB_NAME = 'savely';
export const DB_VERSION = 6;

type UpgradeTransaction = IDBPTransaction<SavelyDB, StoreNames<SavelyDB>[], 'versionchange'>;

export type Migration = (
  db: IDBPDatabase<SavelyDB>,
  tx: UpgradeTransaction,
) => void | Promise<void>;

/** Version 1: the full schema from scratch. */
const createSchemaV1: Migration = (db) => {
  const items = db.createObjectStore('items', { keyPath: 'id' });
  items.createIndex('savedAt', 'savedAt');
  items.createIndex('archived', 'archivedKey');
  items.createIndex('url', 'url', { unique: true });
  items.createIndex('tags', 'tags', { multiEntry: true });

  db.createObjectStore('contents', { keyPath: 'itemId' });

  const highlights = db.createObjectStore('highlights', { keyPath: 'id' });
  highlights.createIndex('itemId', 'itemId');
};

/** The shape of records before version 2 - the fields arrive only in the migration. */
type LegacyItem = Omit<SavedItem, 'readingProgress'> & { readingProgress?: number };
type LegacyHighlight = Omit<Highlight, 'start' | 'end' | 'prefix' | 'suffix'> &
  Partial<Pick<Highlight, 'start' | 'end' | 'prefix' | 'suffix'>>;

/**
 * Version 2: reading progress on items and text anchors on highlights. The
 * migration only **adds** fields with default values - no existing record is
 * deleted or overwritten.
 */
const migrateToV2: Migration = async (_db, tx) => {
  const items = tx.objectStore('items');
  let item = await items.openCursor();
  while (item !== null) {
    const value = item.value as LegacyItem;
    if (typeof value.readingProgress !== 'number') {
      await item.update({ ...value, readingProgress: 0 });
    }
    item = await item.continue();
  }

  const highlights = tx.objectStore('highlights');
  let highlight = await highlights.openCursor();
  while (highlight !== null) {
    const value = highlight.value as LegacyHighlight;
    if (typeof value.start !== 'number') {
      // Without offsets only the quote remains - `locate` can find it anyway.
      await highlight.update({ ...value, start: 0, end: 0, prefix: '', suffix: '' });
    }
    highlight = await highlight.continue();
  }
};

/**
 * Version 3: the store for automatic metadata backups. The store only, no
 * rewriting of existing records - the first backup comes from the alarm.
 */
const migrateToV3: Migration = (db) => {
  const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
  snapshots.createIndex('createdAt', 'createdAt');
};

/** The shape of records before version 4. */
type LegacyItemV3 = Omit<SavedItem, 'updatedAt'> & { updatedAt?: number };

/**
 * Version 4: `updatedAt` on items and the tombstone store - both for sync.
 * Existing records get `updatedAt` equal to `savedAt`: the first merge will
 * treat them as changes made at save time, which is as gentle as it gets.
 */
const migrateToV4: Migration = async (db, tx) => {
  db.createObjectStore('tombstones', { keyPath: 'url' });

  const items = tx.objectStore('items');
  let cursor = await items.openCursor();
  while (cursor !== null) {
    const value = cursor.value as LegacyItemV3;
    if (typeof value.updatedAt !== 'number') {
      await cursor.update({ ...value, updatedAt: value.savedAt });
    }
    cursor = await cursor.continue();
  }
};

/**
 * Version 5: the store for site icons. A new store only - the icons themselves
 * arrive with the next save of a page from a given site.
 */
const migrateToV5: Migration = (db) => {
  db.createObjectStore('favicons', { keyPath: 'domain' });
};

/**
 * Version 6: the store for the sync base. Empty until the next successful
 * push - until then a merge falls back to the union it always did.
 */
const migrateToV6: Migration = (db) => {
  db.createObjectStore('syncBase', { keyPath: 'url' });
};

/**
 * An explicit switch over versions - the single place migrations are added to.
 * Every new version is a new `case` that receives the database after the
 * previous steps (see the loop in `runMigrations`), so migrations are
 * incremental and never rebuild the schema from scratch over existing data.
 */
function migrationFor(version: number): Migration | undefined {
  switch (version) {
    case 1:
      return createSchemaV1;
    case 2:
      return migrateToV2;
    case 3:
      return migrateToV3;
    case 4:
      return migrateToV4;
    case 5:
      return migrateToV5;
    case 6:
      return migrateToV6;
    default:
      return undefined;
  }
}

/**
 * Runs the migrations in order, from `oldVersion + 1` up to `newVersion`.
 *
 * Deliberately not `async`: the first step has to start synchronously, still
 * inside the `upgradeneeded` handler. After an `await` the versionchange
 * transaction can already be inactive for schema operations, and then
 * `createObjectStore` blows up. The later steps (data migrations) run as a
 * chain and only wait on IndexedDB requests, which keeps the transaction alive.
 *
 * A missing migration for a version is an error, not a silent skip - otherwise
 * the schema would drift from the code and we would find out only in
 * production.
 */
function runMigrations(
  db: IDBPDatabase<SavelyDB>,
  tx: UpgradeTransaction,
  oldVersion: number,
  newVersion: number,
  overrides: Record<number, Migration> | undefined,
): Promise<void> {
  const steps: Migration[] = [];
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migration = overrides?.[version] ?? migrationFor(version);
    if (migration === undefined) {
      return Promise.reject(new Error(`No migration of the "${DB_NAME}" database to version ${version}.`));
    }
    steps.push(migration);
  }

  let chain: Promise<void> | null = null;
  for (const step of steps) {
    chain = chain === null ? Promise.resolve(step(db, tx)) : chain.then(() => step(db, tx));
  }
  return chain ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface OpenDbOptions {
  /** Version override - for migration tests. */
  version?: number;
  /** Overriding/extending the migrations - for migration tests. */
  migrations?: Record<number, Migration>;
}

/**
 * The connection cache. It lives exactly as long as the module: after the
 * service worker is suspended (CLAUDE.md 5.5) we start over, and that is fine -
 * this is a cache, not state.
 */
let connection: Promise<IDBPDatabase<SavelyDB>> | null = null;

/**
 * Opens the database. With no arguments it returns the shared, cached
 * connection. With `options` it opens a one-off (uncached) connection - that is
 * how migrations are tested without touching the rest of the app's state.
 */
export async function openDb(options?: OpenDbOptions): Promise<IDBPDatabase<SavelyDB>> {
  const version = options?.version ?? DB_VERSION;
  const overrides = options?.migrations;

  const open = (): Promise<IDBPDatabase<SavelyDB>> =>
    openDB<SavelyDB>(DB_NAME, version, {
      upgrade(db, oldVersion, newVersion, tx) {
        runMigrations(db, tx, oldVersion, newVersion ?? version, overrides).catch(
          (error: unknown) => {
            // An aborted versionchange transaction = opening the database ends
            // in an error and we stay on the old version. Better than half a schema.
            console.error('[savely] the database migration failed:', error);
            // After `abort()` the `tx.done` promise rejects as well; we take it
            // over here so no unhandled rejection is left in the background.
            void tx.done.catch(() => undefined);
            try {
              tx.abort();
            } catch {
              // The transaction may have failed on its own - nothing to do.
            }
          },
        );
      },
      blocking() {
        // Another context wants to raise the version - we release the
        // connection so the upgrade does not get stuck on `blocked`.
        void closeDb();
      },
    });

  if (options !== undefined) return open();

  connection ??= open();
  return connection;
}

/** Closes the shared connection (tests, a reset after a migration). */
export async function closeDb(): Promise<void> {
  const pending = connection;
  connection = null;
  if (pending === null) return;
  (await pending).close();
}

/** Deletes the whole database. Used in tests and by "delete my data". */
export async function deleteDb(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME);
}

// ---------------------------------------------------------------------------
// Shared by the store modules
// ---------------------------------------------------------------------------

/** Keeps the derived fields (the index key) in one place. */
export function withDerived(item: Omit<SavedItem, 'archivedKey'>): SavedItem {
  return { ...item, archivedKey: item.archived ? 1 : 0 };
}

/**
 * Runs `write` in one read-write transaction over `stores`: either all of it
 * lands or none of it does.
 *
 * An error thrown mid-way (an unclonable record, say) does NOT abort the
 * transaction by itself - IndexedDB would commit what already landed and leave
 * half a write behind. Hence the explicit rollback.
 */
export async function writeAtomically<Name extends StoreNames<SavelyDB>, Result>(
  stores: Name[],
  write: (tx: IDBPTransaction<SavelyDB, Name[], 'readwrite'>) => Promise<Result>,
): Promise<Result> {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');

  try {
    const result = await write(tx);
    await tx.done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may have failed on its own - then there is nothing to roll back.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/**
 * Removes an item with everything hanging off it and answers with what it
 * took out. Deleting, and a deletion arriving by sync, both go through here,
 * so neither can forget a store and leave orphans in `contents` or
 * `highlights`.
 */
export async function removeItemRecords(
  tx: IDBPTransaction<SavelyDB, ('items' | 'contents' | 'highlights' | 'tombstones')[], 'readwrite'>,
  id: string,
): Promise<{ content: ItemContent | undefined; highlights: Highlight[] }> {
  const content = await tx.objectStore('contents').get(id);
  const highlights: Highlight[] = [];

  await tx.objectStore('items').delete(id);
  await tx.objectStore('contents').delete(id);
  let cursor = await tx.objectStore('highlights').index('itemId').openCursor(IDBKeyRange.only(id));
  while (cursor !== null) {
    highlights.push(cursor.value);
    await cursor.delete();
    cursor = await cursor.continue();
  }
  return { content, highlights };
}
