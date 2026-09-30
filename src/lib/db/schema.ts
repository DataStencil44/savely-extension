import {
  openDB,
  deleteDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

import type { Highlight, ItemContent, SavedItem, Tombstone } from '@/types/item';

export type { Highlight, ItemContent, ItemStatus, SavedItem, Tombstone } from '@/types/item';

export interface Snapshot {
  id: string;
  createdAt: number;
  itemCount: number;
  items: SavedItem[];
}

export type SnapshotSummary = Omit<Snapshot, 'items'>;

export interface SiteIcon {
  domain: string;
  dataUrl: string;
  updatedAt: number;
}

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

export const DB_NAME = 'savely';
export const DB_VERSION = 6;

type UpgradeTransaction = IDBPTransaction<SavelyDB, StoreNames<SavelyDB>[], 'versionchange'>;

export type Migration = (
  db: IDBPDatabase<SavelyDB>,
  tx: UpgradeTransaction,
) => void | Promise<void>;

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

type LegacyItem = Omit<SavedItem, 'readingProgress'> & { readingProgress?: number };
type LegacyHighlight = Omit<Highlight, 'start' | 'end' | 'prefix' | 'suffix'> &
  Partial<Pick<Highlight, 'start' | 'end' | 'prefix' | 'suffix'>>;

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
      await highlight.update({ ...value, start: 0, end: 0, prefix: '', suffix: '' });
    }
    highlight = await highlight.continue();
  }
};

const migrateToV3: Migration = (db) => {
  const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
  snapshots.createIndex('createdAt', 'createdAt');
};

type LegacyItemV3 = Omit<SavedItem, 'updatedAt'> & { updatedAt?: number };

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

const migrateToV5: Migration = (db) => {
  db.createObjectStore('favicons', { keyPath: 'domain' });
};

const migrateToV6: Migration = (db) => {
  db.createObjectStore('syncBase', { keyPath: 'url' });
};

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

export interface OpenDbOptions {
  version?: number;
  migrations?: Record<number, Migration>;
}

let connection: Promise<IDBPDatabase<SavelyDB>> | null = null;

export async function openDb(options?: OpenDbOptions): Promise<IDBPDatabase<SavelyDB>> {
  const version = options?.version ?? DB_VERSION;
  const overrides = options?.migrations;

  const open = (): Promise<IDBPDatabase<SavelyDB>> =>
    openDB<SavelyDB>(DB_NAME, version, {
      upgrade(db, oldVersion, newVersion, tx) {
        runMigrations(db, tx, oldVersion, newVersion ?? version, overrides).catch(
          (error: unknown) => {
            console.error('[savely] the database migration failed:', error);
            void tx.done.catch(() => undefined);
            try {
              tx.abort();
            } catch {
              // ignore
            }
          },
        );
      },
      blocking() {
        void closeDb();
      },
    });

  if (options !== undefined) return open();

  connection ??= open();
  return connection;
}

export async function closeDb(): Promise<void> {
  const pending = connection;
  connection = null;
  if (pending === null) return;
  (await pending).close();
}

export async function deleteDb(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME);
}

export function withDerived(item: Omit<SavedItem, 'archivedKey'>): SavedItem {
  return { ...item, archivedKey: item.archived ? 1 : 0 };
}

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
      // ignore
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

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
