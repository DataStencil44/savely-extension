import { openDb, type Highlight } from './schema';

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

export async function listHighlights(itemId: string): Promise<Highlight[]> {
  const db = await openDb();
  const highlights = await db.getAllFromIndex('highlights', 'itemId', IDBKeyRange.only(itemId));
  return highlights.sort((a, b) => a.createdAt - b.createdAt);
}

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
