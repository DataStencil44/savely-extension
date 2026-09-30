import { openDb, withDerived, type ItemContent } from './schema';

export interface SetContentInput {
  html: string;
  text: string;
  contentHash?: string;
}

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

export async function listContentIds(): Promise<string[]> {
  const db = await openDb();
  return db.getAllKeys('contents');
}

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

export async function putFavicon(domain: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  await db.put('favicons', { domain, dataUrl, updatedAt: Date.now() });
}

export async function getFavicon(domain: string): Promise<string | undefined> {
  const db = await openDb();
  const icon = await db.get('favicons', domain);
  return icon?.dataUrl;
}

export async function listFavicons(): Promise<Map<string, string>> {
  const db = await openDb();
  const icons = await db.getAll('favicons');
  return new Map(icons.map((icon) => [icon.domain, icon.dataUrl]));
}
