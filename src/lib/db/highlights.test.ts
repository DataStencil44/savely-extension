import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addHighlight,
  deleteDb,
  listHighlights,
  saveItem,
} from './index';

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('highlights', () => {
  it('adds and returns highlights by itemId, in insertion order', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const other = await saveItem({ url: 'https://example.com/b' });

    await addHighlight({ itemId: item.id, text: 'second', createdAt: 200, start: 10, end: 16 });
    await addHighlight({ itemId: item.id, text: 'first', createdAt: 100, note: 'a note', start: 0, end: 8 });
    await addHighlight({ itemId: other.id, text: 'alien', createdAt: 150, start: 0, end: 5 });

    const highlights = await listHighlights(item.id);
    expect(highlights.map((h) => h.text)).toEqual(['first', 'second']);
    expect(highlights[0]?.note).toBe('a note');
    expect(highlights[1]?.note).toBeNull();
  });

  it('does not add a highlight to an unknown item', async () => {
    await expect(addHighlight({ itemId: 'no-such-id', text: 'x', start: 0, end: 1 })).rejects.toThrow(
      /no item/,
    );
  });
});
