/**
 * The heavy stores: article bodies, and the site icons the list draws without
 * going to the network.
 */
import { openDb, withDerived, type ItemContent } from './schema';

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
