import { describe, expect, it } from 'vitest';

import { gunzipFromBase64, gzipToBase64 } from './compress';
import { SyncPayloadError, buildFiles, parseFiles } from './payload';
import {
  CONTENTS_FILE,
  METADATA_FILE,
  SYNC_FORMAT,
  SYNC_FORMAT_VERSION,
  type SyncPayload,
} from './types';

const URL_A = 'https://a.example/1';

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    schemaVersion: 4,
    updatedAt: 5_000,
    items: [
      {
        url: URL_A,
        resolvedUrl: `${URL_A}?utm_source=nl`,
        title: 'A title',
        excerpt: 'an excerpt',
        byline: 'Anna Kowalska',
        siteName: null,
        lang: 'en',
        wordCount: 400,
        estReadingMinutes: 2,
        savedAt: 1_000,
        updatedAt: 2_000,
        readAt: null,
        archived: false,
        favorite: true,
        tags: ['rust'],
        contentHash: null,
        status: 'ready',
        readingProgress: 0.5,
        highlights: [
          { text: 'a quote', note: 'a note', createdAt: 1_500, start: 0, end: 7, prefix: '', suffix: '' },
        ],
      },
    ],
    tombstones: [{ url: 'https://b.example/2', deletedAt: 3_000 }],
    contents: { [URL_A]: { html: '<p>content</p>', text: 'content', updatedAt: 1_800 } },
    ...overrides,
  };
}

describe('gzip + base64', () => {
  it('round-trips, including non-ASCII characters', async () => {
    const text = 'zażółć gęślą jaźń '.repeat(50);
    expect(await gunzipFromBase64(await gzipToBase64(text))).toBe(text);
  });

  it('really does compress repetitive text', async () => {
    const text = '<p>the same paragraph</p>'.repeat(500);
    const packed = await gzipToBase64(text);
    expect(packed.length).toBeLessThan(text.length / 5);
  });

  it('tolerates base64 wrapped with whitespace', async () => {
    const packed = await gzipToBase64('a short piece of content');
    const wrapped = (packed.match(/.{1,40}/g) ?? []).join('\n');
    expect(await gunzipFromBase64(wrapped)).toBe('a short piece of content');
  });
});

describe('buildFiles and parseFiles', () => {
  it('round-trip without losses', async () => {
    const files = await buildFiles(payload());
    expect(Object.keys(files).sort()).toEqual([CONTENTS_FILE, METADATA_FILE].sort());

    const parsed = await parseFiles(files);
    expect(parsed.items).toEqual(payload().items);
    expect(parsed.tombstones).toEqual(payload().tombstones);
    expect(parsed.contents).toEqual(payload().contents);
    expect(parsed.schemaVersion).toBe(4);
  });

  it('the metadata stays human-readable, the content is compressed', async () => {
    const files = await buildFiles(payload());

    expect(files[METADATA_FILE]).toContain('"title": "A title"');
    expect(files[CONTENTS_FILE]).not.toContain('<p>');
    expect(files[CONTENTS_FILE]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('unacceptable files', () => {
  it('a missing metadata file', async () => {
    await expect(parseFiles({ 'anything.txt': '{}' })).rejects.toThrow(SyncPayloadError);
  });

  it('metadata that is not JSON', async () => {
    await expect(parseFiles({ [METADATA_FILE]: 'not json' })).rejects.toThrow(/JSON/);
  });

  it('a foreign file with valid JSON', async () => {
    await expect(parseFiles({ [METADATA_FILE]: '{"items":[]}' })).rejects.toThrow(
      /Savely sync data/,
    );
  });

  it('a newer format version', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: SYNC_FORMAT_VERSION + 1,
        items: [],
      }),
    };
    await expect(parseFiles(files)).rejects.toThrow(/newer format/);
  });
});

describe('damaged fragments', () => {
  it('broken content does not invalidate the metadata', async () => {
    const files = await buildFiles(payload());
    files[CONTENTS_FILE] = 'this is certainly not gzip';

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.contents).toEqual({});
  });

  it('an item without an address drops out, the rest stays', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [{ title: 'No address' }, { url: URL_A, title: 'A good one' }, 'not an object'],
      }),
    };

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe('A good one');
  });

  it('a missing updatedAt falls back to the save date, not to now', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [{ url: URL_A, savedAt: 1_234 }],
      }),
    };

    expect((await parseFiles(files)).items[0]?.updatedAt).toBe(1_234);
  });

  it('a duplicate address in the file does not create two items', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [
          { url: URL_A, title: 'The first' },
          { url: `${URL_A}?utm_source=x`, title: 'The same after normalization' },
        ],
      }),
    };

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe('The first');
  });
});
