/**
 * The storage layer: IndexedDB through `idb`.
 *
 * The `savely` database, six stores:
 *   items      - item metadata (light, loaded into the list)
 *   contents   - sanitized HTML + plain text, kept apart on purpose:
 *                the list must not pull in megabytes of content just to open
 *   highlights - selections inside the content, linked by itemId
 *   snapshots  - automatic backups of METADATA (no content), the last three
 *   tombstones - traces of deleted items, for sync
 *   favicons   - one site icon per domain, as bytes, so the list draws
 *                something without going to the network
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

import { estimateReadingMinutes } from '@/types/article';

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
}

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/** Purely tracking parameters - they do not change the content, so they break deduplication. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref']);
const TRACKING_PREFIX = 'utm_';

/**
 * Reduces an address to a comparable form: strips `utm_*`, `fbclid`, `gclid`
 * and `ref`. The rest (path, remaining parameters, fragment) is left alone -
 * on many sites the fragment or `?p=123` is the article's only identifier.
 *
 * An unparseable address comes back trimmed but untouched: better to save
 * something odd than to fail the save.
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  const params = parsed.searchParams;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(lower)) {
      params.delete(key);
    }
  }

  const query = params.toString();
  parsed.search = query === '' ? '' : `?${query}`;
  return parsed.toString();
}

/** Tags are kept in one canonical form so the multiEntry index stays predictable. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Schema and migrations
// ---------------------------------------------------------------------------

export const DB_NAME = 'savely';
export const DB_VERSION = 5;

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
// items
// ---------------------------------------------------------------------------

export interface SaveItemInput {
  /** The page address (the original). */
  url: string;
  /** The address after redirects, if different from `url`. */
  resolvedUrl?: string;
  title?: string;
  excerpt?: string;
  byline?: string | null;
  siteName?: string | null;
  lang?: string | null;
  wordCount?: number;
  estReadingMinutes?: number;
  tags?: string[];
  status?: ItemStatus;
  contentHash?: string | null;
  /** For tests and imports - defaults to `Date.now()`. */
  savedAt?: number;
}

export type ItemPatch = Partial<
  Pick<
    SavedItem,
    | 'title'
    | 'excerpt'
    | 'byline'
    | 'siteName'
    | 'lang'
    | 'wordCount'
    | 'estReadingMinutes'
    | 'readAt'
    | 'readingProgress'
    | 'archived'
    | 'favorite'
    | 'tags'
    | 'contentHash'
    | 'status'
  >
>;

export interface ItemFilter {
  archived?: boolean;
  favorite?: boolean;
  /** `true` = unread only (`readAt === null`). */
  unread?: boolean;
  status?: ItemStatus;
  /** A conjunction - the item must carry every listed tag. */
  tags?: string[];
}

export type ItemSort = 'newest' | 'oldest';

export interface ListItemsOptions {
  filter?: ItemFilter;
  sort?: ItemSort;
  limit?: number;
  /** The token from the previous page (`nextCursor`). */
  cursor?: string | null;
}

export interface ItemPage {
  items: SavedItem[];
  /** `null` = the end of the list. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;

/** Keeps the derived fields (the index key) in one place. */
function withDerived(item: Omit<SavedItem, 'archivedKey'>): SavedItem {
  return { ...item, archivedKey: item.archived ? 1 : 0 };
}

function createItem(input: SaveItemInput, now: number): SavedItem {
  const wordCount = input.wordCount ?? 0;
  return withDerived({
    id: crypto.randomUUID(),
    url: normalizeUrl(input.resolvedUrl ?? input.url),
    resolvedUrl: input.resolvedUrl ?? input.url,
    title: input.title ?? '',
    excerpt: input.excerpt ?? '',
    byline: input.byline ?? null,
    siteName: input.siteName ?? null,
    lang: input.lang ?? null,
    wordCount,
    estReadingMinutes: input.estReadingMinutes ?? estimateReadingMinutes(wordCount),
    savedAt: input.savedAt ?? now,
    // An explicit `savedAt` marks a historical record (an import, a restored
    // state), so the last change is historical too - otherwise an old entry
    // would win against newer data on the other side of a sync.
    updatedAt: input.savedAt ?? now,
    readAt: null,
    archived: false,
    favorite: false,
    tags: normalizeTags(input.tags ?? []),
    contentHash: input.contentHash ?? null,
    status: input.status ?? 'pending',
    readingProgress: 0,
  });
}

/**
 * Re-saving a known address refreshes the metadata and bumps `savedAt` (the
 * item returns to the top of the list), but does NOT touch user state:
 * `archived`, `favorite` and `readAt` stay, and tags are unioned, not
 * overwritten.
 */
function refreshItem(existing: SavedItem, input: SaveItemInput, now: number): SavedItem {
  const wordCount = input.wordCount ?? existing.wordCount;
  const estReadingMinutes =
    input.estReadingMinutes ??
    (input.wordCount === undefined ? existing.estReadingMinutes : estimateReadingMinutes(wordCount));

  return withDerived({
    ...existing,
    url: normalizeUrl(input.resolvedUrl ?? input.url),
    resolvedUrl: input.resolvedUrl ?? input.url,
    title: input.title ?? existing.title,
    excerpt: input.excerpt ?? existing.excerpt,
    byline: input.byline ?? existing.byline,
    siteName: input.siteName ?? existing.siteName,
    lang: input.lang ?? existing.lang,
    wordCount,
    estReadingMinutes,
    savedAt: input.savedAt ?? now,
    updatedAt: now,
    tags: normalizeTags([...existing.tags, ...(input.tags ?? [])]),
    contentHash: input.contentHash ?? existing.contentHash,
    status: input.status ?? existing.status,
  });
}

/**
 * Saves an item, or refreshes an existing one with the same (normalized)
 * address. Looking up the duplicate and writing share one transaction, so two
 * concurrent saves of the same URL will not create two entries.
 */
export async function saveItem(input: SaveItemInput): Promise<SavedItem> {
  const db = await openDb();
  const now = Date.now();
  const normalized = normalizeUrl(input.resolvedUrl ?? input.url);

  const tx = db.transaction('items', 'readwrite');
  const existing = await tx.store.index('url').get(normalized);
  const item = existing === undefined ? createItem(input, now) : refreshItem(existing, input, now);
  await tx.store.put(item);
  await tx.done;

  return item;
}

export async function getItem(id: string): Promise<SavedItem | undefined> {
  const db = await openDb();
  return db.get('items', id);
}

/** An item by address - the address is normalized, so `?utm_*` does not get in the way. */
export async function getItemByUrl(url: string): Promise<SavedItem | undefined> {
  const db = await openDb();
  return db.getFromIndex('items', 'url', normalizeUrl(url));
}

function encodeCursor(item: SavedItem): string {
  return `${item.savedAt}|${item.id}`;
}

function decodeCursor(token: string): { savedAt: number; id: string } | null {
  const separator = token.indexOf('|');
  if (separator <= 0) return null;
  const savedAt = Number(token.slice(0, separator));
  const id = token.slice(separator + 1);
  if (!Number.isFinite(savedAt) || id === '') return null;
  return { savedAt, id };
}

function matchesFilter(
  item: SavedItem,
  filter: ItemFilter,
  allowedIds: Set<string> | null,
): boolean {
  if (allowedIds !== null && !allowedIds.has(item.id)) return false;
  if (filter.archived !== undefined && item.archived !== filter.archived) return false;
  if (filter.favorite !== undefined && item.favorite !== filter.favorite) return false;
  if (filter.unread !== undefined && (item.readAt === null) !== filter.unread) return false;
  if (filter.status !== undefined && item.status !== filter.status) return false;
  return true;
}

/**
 * The set of ids matching every tag, computed from the multiEntry index.
 * `null` = no tag filter (nothing is narrowed down).
 */
async function idsForTags(
  tx: IDBPTransaction<SavelyDB, ['items'], 'readonly' | 'readwrite'>,
  tags: readonly string[],
): Promise<Set<string> | null> {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return null;

  const index = tx.objectStore('items').index('tags');
  let result: Set<string> | null = null;
  for (const tag of normalized) {
    // An explicit annotation: with a union of transaction modes idb loses the key type.
    const tagged: string[] = await index.getAllKeys(tag);
    const keys = new Set<string>(tagged);

    if (result === null) {
      result = keys;
    } else {
      const intersection = new Set<string>();
      for (const id of result) {
        if (keys.has(id)) intersection.add(id);
      }
      result = intersection;
    }
    if (result.size === 0) break;
  }
  return result;
}

/**
 * A page of the list, sorted by `savedAt` from the index and paginated by
 * keyset (`savedAt` + `id`) rather than by offset - adding an item mid-scroll
 * does not shift the window or drop rows.
 */
export async function listItems(options: ListItemsOptions = {}): Promise<ItemPage> {
  const filter = options.filter ?? {};
  const sort = options.sort ?? 'newest';
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const cursorToken = options.cursor ?? null;
  const from = cursorToken === null ? null : decodeCursor(cursorToken);

  const db = await openDb();
  const tx = db.transaction('items', 'readonly');
  const allowedIds = await idsForTags(tx, filter.tags ?? []);
  const index = tx.store.index('savedAt');

  const direction: IDBCursorDirection = sort === 'newest' ? 'prev' : 'next';
  const range =
    from === null
      ? null
      : sort === 'newest'
        ? IDBKeyRange.upperBound(from.savedAt)
        : IDBKeyRange.lowerBound(from.savedAt);

  const items: SavedItem[] = [];
  let skipping = from !== null;
  let cursor = await index.openCursor(range, direction);

  while (cursor !== null && items.length < limit) {
    const item = cursor.value;

    if (skipping && from !== null) {
      if (item.savedAt !== from.savedAt) {
        // We left the block sharing one `savedAt` - stop skipping from here.
        skipping = false;
      } else if (sort === 'newest' ? item.id >= from.id : item.id <= from.id) {
        cursor = await cursor.continue();
        continue;
      } else {
        skipping = false;
      }
    }

    if (matchesFilter(item, filter, allowedIds)) items.push(item);
    cursor = await cursor.continue();
  }

  await tx.done;

  // A cursor is returned only when something unseen is left in the index.
  const last = items[items.length - 1];
  const nextCursor =
    cursor !== null && last !== undefined && items.length === limit ? encodeCursor(last) : null;

  return { items, nextCursor };
}

/** Overwrites the given fields. The address cannot be changed - that keeps dedup honest. */
export async function updateItem(id: string, patch: ItemPatch): Promise<SavedItem> {
  const db = await openDb();
  const tx = db.transaction('items', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing === undefined) {
    await tx.done;
    throw new Error(`There is no item with id ${id}.`);
  }

  const merged: SavedItem = withDerived({
    ...existing,
    ...patch,
    updatedAt: Date.now(),
    tags: patch.tags === undefined ? existing.tags : normalizeTags(patch.tags),
  });
  await tx.store.put(merged);
  await tx.done;

  return merged;
}

/**
 * Deletes an item together with its content and highlights - all in one
 * transaction, so no orphaned records are left in `contents`/`highlights`.
 * Returns `false` when the item did not exist.
 */
export async function deleteItem(id: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');
  const existing = await tx.objectStore('items').get(id);

  if (existing !== undefined) {
    await tx.objectStore('items').delete(id);
    await tx.objectStore('contents').delete(id);
    const highlights = tx.objectStore('highlights').index('itemId');
    let cursor = await highlights.openCursor(IDBKeyRange.only(id));
    while (cursor !== null) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    // The tombstone goes in the same transaction as the deletion - otherwise
    // an interruption between them would leave a deletion sync never hears
    // about, and the item would come back from another device.
    await tx.objectStore('tombstones').put({ url: existing.url, deletedAt: Date.now() });
  }

  await tx.done;
  return existing !== undefined;
}

export async function countItems(filter: ItemFilter = {}): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('items', 'readonly');
  const keys = Object.keys(filter);
  const tags = normalizeTags(filter.tags ?? []);

  // Paths counted straight from the index - no record scanning.
  if (keys.length === 0) return tx.store.count();
  if (keys.length === 1 && filter.archived !== undefined) {
    return tx.store.index('archived').count(filter.archived ? 1 : 0);
  }
  const onlyTag = tags[0];
  if (keys.length === 1 && tags.length === 1 && onlyTag !== undefined) {
    return tx.store.index('tags').count(onlyTag);
  }

  const allowedIds = await idsForTags(tx, tags);
  let count = 0;
  let cursor = await tx.store.openCursor();
  while (cursor !== null) {
    if (matchesFilter(cursor.value, filter, allowedIds)) count += 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

export interface SetContentInput {
  /** HTML that already went through DOMPurify. */
  html: string;
  text: string;
  contentHash?: string;
}

/**
 * Stores the content and, in the same transaction, flips the item to `ready`
 * (and writes `contentHash` when given). That leaves no intermediate state in
 * which the content is already there while the item still hangs as `pending`.
 */
export async function setContent(itemId: string, input: SetContentInput): Promise<ItemContent> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents'], 'readwrite');
  const item = await tx.objectStore('items').get(itemId);
  if (item === undefined) {
    await tx.done;
    throw new Error(`There is no item with id ${itemId} - not storing the content.`);
  }

  const content: ItemContent = {
    itemId,
    html: input.html,
    text: input.text,
    updatedAt: Date.now(),
  };

  await tx.objectStore('contents').put(content);
  await tx.objectStore('items').put(
    withDerived({
      ...item,
      status: 'ready',
      updatedAt: content.updatedAt,
      contentHash: input.contentHash ?? item.contentHash,
    }),
  );
  await tx.done;

  return content;
}

export async function getContent(itemId: string): Promise<ItemContent | undefined> {
  const db = await openDb();
  return db.get('contents', itemId);
}

/** Keys only - for building the search index in batches without pulling in the content. */
export async function listContentIds(): Promise<string[]> {
  const db = await openDb();
  return db.getAllKeys('contents');
}

/** A batch of content. Called in a loop over `listContentIds`, so one
 *  transaction is not held across the whole database and the UI is not blocked. */
export async function getContents(itemIds: readonly string[]): Promise<ItemContent[]> {
  const db = await openDb();
  const tx = db.transaction('contents', 'readonly');
  const found: ItemContent[] = [];
  for (const id of itemIds) {
    const content = await tx.store.get(id);
    if (content !== undefined) found.push(content);
  }
  await tx.done;
  return found;
}

// ---------------------------------------------------------------------------
// favicons
// ---------------------------------------------------------------------------

/**
 * Stores the icon for a domain, overwriting whatever was there. A site that
 * changes its icon gets the new one at the next save from it - no expiry
 * timer, because nothing here is worth waking the extension up for.
 */
export async function putFavicon(domain: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  await db.put('favicons', { domain, dataUrl, updatedAt: Date.now() });
}

export async function getFavicon(domain: string): Promise<string | undefined> {
  const db = await openDb();
  const icon = await db.get('favicons', domain);
  return icon?.dataUrl;
}

/**
 * Every icon at once, ready for the list to look up by domain.
 *
 * One row per site rather than per item, so this stays in the tens of rows and
 * a few dozen kilobytes even for a database of thousands of articles - cheap
 * enough to read once when the popup opens.
 */
export async function listFavicons(): Promise<Map<string, string>> {
  const db = await openDb();
  const icons = await db.getAll('favicons');
  return new Map(icons.map((icon) => [icon.domain, icon.dataUrl]));
}

// ---------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------

export interface AddHighlightInput {
  itemId: string;
  text: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  note?: string | null;
  createdAt?: number;
}

export async function addHighlight(input: AddHighlightInput): Promise<Highlight> {
  const db = await openDb();
  const tx = db.transaction(['items', 'highlights'], 'readwrite');
  const item = await tx.objectStore('items').get(input.itemId);
  if (item === undefined) {
    await tx.done;
    throw new Error(`There is no item with id ${input.itemId} - not storing the highlight.`);
  }

  const highlight: Highlight = {
    id: crypto.randomUUID(),
    itemId: input.itemId,
    text: input.text,
    note: input.note ?? null,
    createdAt: input.createdAt ?? Date.now(),
    start: input.start,
    end: input.end,
    prefix: input.prefix ?? '',
    suffix: input.suffix ?? '',
  };

  await tx.objectStore('highlights').put(highlight);
  await tx.done;

  return highlight;
}

/** One item's highlights, in the order they were added. */
export async function listHighlights(itemId: string): Promise<Highlight[]> {
  const db = await openDb();
  const highlights = await db.getAllFromIndex('highlights', 'itemId', IDBKeyRange.only(itemId));
  return highlights.sort((a, b) => a.createdAt - b.createdAt);
}

/** The note on a highlight. Throws when the highlight is gone. */
export async function updateHighlight(
  id: string,
  patch: Partial<Pick<Highlight, 'note'>>,
): Promise<Highlight> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing === undefined) {
    await tx.done;
    throw new Error(`There is no highlight with id ${id}.`);
  }

  const merged: Highlight = { ...existing, ...patch };
  await tx.store.put(merged);
  await tx.done;
  return merged;
}

export async function deleteHighlight(id: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing !== undefined) await tx.store.delete(id);
  await tx.done;
  return existing !== undefined;
}

// ---------------------------------------------------------------------------
// Dump and merge (export / import / backups)
// ---------------------------------------------------------------------------

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

/** Metadata only, newest first - for the bookmarks export and for a snapshot. */
export async function listAllItems(): Promise<SavedItem[]> {
  const db = await openDb();
  const items = await db.getAll('items');
  return items.sort((a, b) => b.savedAt - a.savedAt);
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

  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readwrite');

  try {
    const outcome = await writeDump(tx, dump);
    await tx.done;
    return outcome;
  } catch (error) {
    // An error thrown mid-way (an unclonable record, say) does NOT abort the
    // transaction by itself - without this `abort` IndexedDB would commit what
    // already landed and half an import would remain. Hence the explicit
    // rollback.
    try {
      tx.abort();
    } catch {
      // The transaction may have failed on its own - then there is nothing to roll back.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
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

// ---------------------------------------------------------------------------
// Sync: reading the state and writing the merge result
// ---------------------------------------------------------------------------

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
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readonly');
  const state: SyncLocalState = {
    items: await tx.objectStore('items').getAll(),
    contents: await tx.objectStore('contents').getAll(),
    highlights: await tx.objectStore('highlights').getAll(),
    tombstones: await tx.objectStore('tombstones').getAll(),
  };
  await tx.done;
  return state;
}

export async function listTombstones(): Promise<Tombstone[]> {
  const db = await openDb();
  return db.getAll('tombstones');
}

/**
 * Writes the merge result. One transaction across four stores: an interruption
 * halfway rolls everything back, so the database is never left "half synced"
 * (the same rule as for an import).
 *
 * The merging itself lives in `src/lib/sync/merge.ts` - here we only write what
 * it decided, plus the address -> local `id` mapping.
 */
export async function applySync(plan: SyncWritePlan): Promise<SyncWriteOutcome> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');

  try {
    const outcome = await writeSync(tx, plan);
    await tx.done;
    return outcome;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may have failed on its own.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

async function writeSync(
  tx: IDBPTransaction<
    SavelyDB,
    ('items' | 'contents' | 'highlights' | 'tombstones')[],
    'readwrite'
  >,
  plan: SyncWritePlan,
): Promise<SyncWriteOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const highlights = tx.objectStore('highlights');
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
      // The merged set goes in whole: `merge` returns it only when it differs
      // from the local one, so nothing moves here without a reason.
      let cursor = await highlights.index('itemId').openCursor(IDBKeyRange.only(id));
      while (cursor !== null) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      for (const highlight of write.highlights) {
        await highlights.put({ ...highlight, id: crypto.randomUUID(), itemId: id });
        outcome.highlights += 1;
      }
    }
  }

  for (const url of plan.deleteUrls) {
    const existing = await items.index('url').get(url);
    if (existing === undefined) continue;

    await items.delete(existing.id);
    await contents.delete(existing.id);
    let cursor = await highlights.index('itemId').openCursor(IDBKeyRange.only(existing.id));
    while (cursor !== null) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
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
