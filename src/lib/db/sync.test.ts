import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addHighlight,
  applySync,
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

describe('applySync', () => {
  it('keeps the id of every highlight that survives, so an open reader still points at it', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const kept = await addHighlight({ itemId: item.id, text: 'kept', start: 0, end: 4 });
    await addHighlight({ itemId: item.id, text: 'gone', start: 5, end: 9 });

    const { id: _id, archivedKey: _key, ...fields } = item;
    await applySync({
      writes: [
        {
          item: fields,
          content: null,
          highlights: [
            {
              text: 'kept',
              note: 'a note from the other side',
              createdAt: kept.createdAt,
              start: 0,
              end: 4,
              prefix: '',
              suffix: '',
            },
            { text: 'new', note: null, createdAt: 1, start: 10, end: 13, prefix: '', suffix: '' },
          ],
        },
      ],
      deleteUrls: [],
      tombstones: [],
    });

    const after = await listHighlights(item.id);
    expect(after.map((entry) => entry.text).sort()).toEqual(['kept', 'new']);
    expect(after.find((entry) => entry.text === 'kept')).toMatchObject({
      id: kept.id,
      note: 'a note from the other side',
    });
  });
});
