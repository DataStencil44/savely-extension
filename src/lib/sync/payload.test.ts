/**
 * Testy ładunku: obiekt -> dwa pliki -> obiekt.
 *
 * Plik po drugiej stronie da się otworzyć w przeglądarce i ręcznie zepsuć,
 * a starsza wersja rozszerzenia zapisze go inaczej niż nowsza. Dlatego liczy
 * się nie tylko przejście w obie strony, ale i to, co się dzieje, gdy plik
 * przychodzi uszkodzony.
 */
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
        title: 'Tytuł',
        excerpt: 'zajawka',
        byline: 'Anna Kowalska',
        siteName: null,
        lang: 'pl',
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
          { text: 'cytat', note: 'notatka', createdAt: 1_500, start: 0, end: 5, prefix: '', suffix: '' },
        ],
      },
    ],
    tombstones: [{ url: 'https://b.example/2', deletedAt: 3_000 }],
    contents: { [URL_A]: { html: '<p>treść</p>', text: 'treść', updatedAt: 1_800 } },
    ...overrides,
  };
}

describe('gzip + base64', () => {
  it('przechodzi w obie strony, także dla polskich znaków', async () => {
    const text = 'zażółć gęślą jaźń '.repeat(50);
    expect(await gunzipFromBase64(await gzipToBase64(text))).toBe(text);
  });

  it('faktycznie kompresuje powtarzalny tekst', async () => {
    const text = '<p>ten sam akapit</p>'.repeat(500);
    const packed = await gzipToBase64(text);
    expect(packed.length).toBeLessThan(text.length / 5);
  });

  it('znosi base64 połamane białymi znakami', async () => {
    const packed = await gzipToBase64('krótka treść');
    const wrapped = (packed.match(/.{1,40}/g) ?? []).join('\n');
    expect(await gunzipFromBase64(wrapped)).toBe('krótka treść');
  });
});

describe('buildFiles i parseFiles', () => {
  it('przechodzą w obie strony bez strat', async () => {
    const files = await buildFiles(payload());
    expect(Object.keys(files).sort()).toEqual([CONTENTS_FILE, METADATA_FILE].sort());

    const parsed = await parseFiles(files);
    expect(parsed.items).toEqual(payload().items);
    expect(parsed.tombstones).toEqual(payload().tombstones);
    expect(parsed.contents).toEqual(payload().contents);
    expect(parsed.schemaVersion).toBe(4);
  });

  it('metadane zostają czytelne dla człowieka, treści są spakowane', async () => {
    const files = await buildFiles(payload());

    expect(files[METADATA_FILE]).toContain('"title": "Tytuł"');
    // Treść nie może być czytelna wprost - to base64 gzipu.
    expect(files[CONTENTS_FILE]).not.toContain('<p>');
    expect(files[CONTENTS_FILE]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('pliki nie do przyjęcia', () => {
  it('brak pliku metadanych', async () => {
    await expect(parseFiles({ 'cokolwiek.txt': '{}' })).rejects.toThrow(SyncPayloadError);
  });

  it('metadane, które nie są JSON-em', async () => {
    await expect(parseFiles({ [METADATA_FILE]: 'nie json' })).rejects.toThrow(/JSON/);
  });

  it('obcy plik z poprawnym JSON-em', async () => {
    await expect(parseFiles({ [METADATA_FILE]: '{"items":[]}' })).rejects.toThrow(
      /dane synchronizacji/,
    );
  });

  it('nowsza wersja formatu', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: SYNC_FORMAT_VERSION + 1,
        items: [],
      }),
    };
    await expect(parseFiles(files)).rejects.toThrow(/nowszym formacie/);
  });
});

describe('uszkodzone fragmenty', () => {
  it('zepsute treści nie przekreślają metadanych', async () => {
    const files = await buildFiles(payload());
    files[CONTENTS_FILE] = 'to na pewno nie jest gzip';

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.contents).toEqual({});
  });

  it('pozycja bez adresu wypada, reszta zostaje', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [{ title: 'Bez adresu' }, { url: URL_A, title: 'Dobra' }, 'nie obiekt'],
      }),
    };

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe('Dobra');
  });

  it('brak updatedAt cofa się do daty zapisu, nie do teraz', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [{ url: URL_A, savedAt: 1_234 }],
      }),
    };

    expect((await parseFiles(files)).items[0]?.updatedAt).toBe(1_234);
  });

  it('duplikat adresu w pliku nie tworzy dwóch pozycji', async () => {
    const files = {
      [METADATA_FILE]: JSON.stringify({
        format: SYNC_FORMAT,
        formatVersion: 1,
        items: [
          { url: URL_A, title: 'Pierwsza' },
          { url: `${URL_A}?utm_source=x`, title: 'Ta sama po normalizacji' },
        ],
      }),
    };

    const parsed = await parseFiles(files);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.title).toBe('Pierwsza');
  });
});
