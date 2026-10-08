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
  url: string;
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

export async function getItemByUrl(url: string): Promise<SavedItem | undefined> {
  const db = await openDb();
  return db.getFromIndex('items', 'url', normalizeUrl(url));
}

export async function listAllItems(): Promise<SavedItem[]> {
  const db = await openDb();
  const items = await db.getAll('items');
  return items.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : -1));
}

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

export async function updateItem(id: string, patch: ItemPatch): Promise<SavedItem> {
  return modifyItem(id, () => patch);
}

export async function toggleItem(id: string, flag: ItemFlag): Promise<SavedItem> {
  return modifyItem(id, (existing) => ({ [flag]: !existing[flag] }));
}

export interface RemovedItem {
  item: SavedItem;
  content: ItemContent | undefined;
  highlights: Highlight[];
}

export async function deleteItem(id: string): Promise<RemovedItem | null> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readwrite');
  const existing = await tx.objectStore('items').get(id);

  if (existing === undefined) {
    await tx.done;
    return null;
  }

  const { content, highlights } = await removeItemRecords(tx, id);

  await tx.done;
  return { item: existing, content, highlights };
}

export async function restoreItem(removed: RemovedItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readwrite');

  await tx.objectStore('items').put(removed.item);
  if (removed.content !== undefined) await tx.objectStore('contents').put(removed.content);
  for (const highlight of removed.highlights) {
    await tx.objectStore('highlights').put(highlight);
  }

  await tx.done;
}
