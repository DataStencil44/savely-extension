/**
 * The `items` store: saving, reading, changing and deleting an item's metadata.
 */
import { estimateReadingMinutes } from '@/types/article';

import { normalizeTags, normalizeUrl } from '../url';

import {
  openDb,
  removeItemRecords,
  withDerived,
  type Highlight,
  type ItemContent,
  type ItemStatus,
  type SavedItem,
} from './schema';

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

/** The two switches on an item. */
export type ItemFlag = 'archived' | 'favorite';

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

/**
 * Every item's metadata, newest first. The list holds all of it in memory and
 * filters there (see `src/ui/list/store.ts`); the bookmarks export and a
 * snapshot want all of it too.
 */
export async function listAllItems(): Promise<SavedItem[]> {
  const db = await openDb();
  const items = await db.getAll('items');
  return items.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
}

/**
 * Reads the item, lets `change` compute the new fields from what is stored
 * right now, and writes - all in one transaction.
 */
async function modifyItem(
  id: string,
  change: (existing: SavedItem) => ItemPatch,
): Promise<SavedItem> {
  const db = await openDb();
  const tx = db.transaction('items', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing === undefined) {
    await tx.done;
    throw new Error(`There is no item with id ${id}.`);
  }

  const patch = change(existing);
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

/** Overwrites the given fields. The address cannot be changed - that keeps dedup honest. */
export async function updateItem(id: string, patch: ItemPatch): Promise<SavedItem> {
  return modifyItem(id, () => patch);
}

/**
 * Flips a switch on what the database holds, not on what the caller last saw.
 *
 * A page that computes `!item.favorite` itself writes back whatever state it
 * drew - and a card drawn before a change from another context turns a
 * favourite on again when the user meant to turn it off.
 */
export async function toggleItem(id: string, flag: ItemFlag): Promise<SavedItem> {
  return modifyItem(id, (existing) => ({ [flag]: !existing[flag] }));
}

/**
 * Everything a deletion took out of the database - enough to put it back.
 *
 * The list hands the user five seconds to undo, and it can only offer that
 * because the deletion answers with what it removed. `content` is missing for
 * an item saved as an entry only.
 */
export interface RemovedItem {
  item: SavedItem;
  content: ItemContent | undefined;
  highlights: Highlight[];
}

/**
 * Deletes an item with everything hanging off it, and answers with the record
 * as it was - `null` if there was no such item.
 */
export async function deleteItem(id: string): Promise<RemovedItem | null> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');
  const existing = await tx.objectStore('items').get(id);

  if (existing === undefined) {
    await tx.done;
    return null;
  }

  const { content, highlights } = await removeItemRecords(tx, id);
  // The tombstone goes in the same transaction as the deletion - otherwise
  // an interruption between them would leave a deletion sync never hears
  // about, and the item would come back from another device.
  await tx.objectStore('tombstones').put({ url: existing.url, deletedAt: Date.now() });

  await tx.done;
  return { item: existing, content, highlights };
}

/**
 * Puts back what `deleteItem` took out, under the same id.
 *
 * The grave goes with it, or the next sync would carry out the deletion the
 * user has just taken back - on this device and on every other one.
 */
export async function restoreItem(removed: RemovedItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');

  await tx.objectStore('items').put(removed.item);
  if (removed.content !== undefined) await tx.objectStore('contents').put(removed.content);
  for (const highlight of removed.highlights) {
    await tx.objectStore('highlights').put(highlight);
  }
  await tx.objectStore('tombstones').delete(removed.item.url);

  await tx.done;
}
