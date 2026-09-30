import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteDb,
  getContent,
  getItem,
  saveItem,
  setContent,
} from './index';

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('contents', () => {
  it('stores the content and marks the item ready in the same transaction', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    expect(item.status).toBe('pending');

    const content = await setContent(item.id, {
      html: '<p>sanitized</p>',
      text: 'sanitized',
      contentHash: 'sha256-abc',
    });

    expect(content.itemId).toBe(item.id);
    await expect(getContent(item.id)).resolves.toMatchObject({
      html: '<p>sanitized</p>',
      text: 'sanitized',
    });

    const refreshed = await getItem(item.id);
    expect(refreshed?.status).toBe('ready');
    expect(refreshed?.contentHash).toBe('sha256-abc');
  });

  it('does not store content for an unknown item', async () => {
    await expect(setContent('no-such-id', { html: '', text: '' })).rejects.toThrow(
      /no item/,
    );
    await expect(getContent('no-such-id')).resolves.toBeUndefined();
  });
});
