/**
 * Testy warstwy przechowywania na `fake-indexeddb`.
 *
 * Kazdy test dostaje czysta baze (`deleteDb` w `beforeEach`), bo modul trzyma
 * wspoldzielone polaczenie i inaczej wersje/dane przeciekalyby miedzy testami.
 */
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_LIMIT,
  addHighlight,
  clearAllData,
  closeDb,
  countItems,
  createSnapshot,
  createSnapshotIfDue,
  dataStats,
  deleteDb,
  deleteItem,
  exportAll,
  getContent,
  getItem,
  getItemByUrl,
  importDump,
  listAllItems,
  listHighlights,
  listItems,
  listSnapshots,
  normalizeTags,
  normalizeUrl,
  openDb,
  restoreSnapshot,
  saveItem,
  setContent,
  updateItem,
  type Migration,
  type SavedItem,
} from './db';

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('normalizeUrl', () => {
  it('wycina parametry sledzace', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(normalizeUrl('https://example.com/a?fbclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?gclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?ref=newsletter')).toBe('https://example.com/a');
  });

  it('zostawia parametry, ktore identyfikuja tresc, i fragment', () => {
    expect(normalizeUrl('https://example.com/?p=123&utm_campaign=q#rozdzial-2')).toBe(
      'https://example.com/?p=123#rozdzial-2',
    );
  });

  it('nie zostawia osieroconego znaku zapytania', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x')).toBe('https://example.com/a');
  });

  it('adres nie do sparsowania wraca bez zmian', () => {
    expect(normalizeUrl('  nie-jest-urlem  ')).toBe('nie-jest-urlem');
  });
});

describe('normalizeTags', () => {
  it('przycina, obniza wielkosc liter, odsiewa duplikaty i sortuje', () => {
    expect(normalizeTags([' Rust ', 'rust', 'TypeScript', '', '   '])).toEqual([
      'rust',
      'typescript',
    ]);
  });
});

describe('saveItem', () => {
  it('tworzy pozycje z domyslnymi wartosciami', async () => {
    const item = await saveItem({
      url: 'https://example.com/artykul',
      title: 'Artykul',
      wordCount: 400,
    });

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.url).toBe('https://example.com/artykul');
    expect(item.resolvedUrl).toBe('https://example.com/artykul');
    expect(item.status).toBe('pending');
    expect(item.archived).toBe(false);
    expect(item.favorite).toBe(false);
    expect(item.readAt).toBeNull();
    expect(item.tags).toEqual([]);
    expect(item.estReadingMinutes).toBe(2);
    expect(item.archivedKey).toBe(0);

    await expect(getItem(item.id)).resolves.toEqual(item);
  });

  it('zapisuje adres znormalizowany, ale zachowuje oryginal', async () => {
    const item = await saveItem({ url: 'https://example.com/a?utm_source=newsletter&id=7' });

    expect(item.url).toBe('https://example.com/a?id=7');
    expect(item.resolvedUrl).toBe('https://example.com/a?utm_source=newsletter&id=7');
  });

  it('przy przekierowaniu deduplikuje po adresie docelowym', async () => {
    const item = await saveItem({
      url: 'https://skracacz.example/xyz',
      resolvedUrl: 'https://example.com/cel',
    });

    expect(item.url).toBe('https://example.com/cel');
    expect(item.resolvedUrl).toBe('https://example.com/cel');
  });

  it('ten sam adres nie tworzy duplikatu, tylko odswieza wpis', async () => {
    const first = await saveItem({
      url: 'https://example.com/a',
      title: 'Stary tytul',
      tags: ['rust'],
      savedAt: 1_000,
      wordCount: 100,
    });
    await updateItem(first.id, { favorite: true, archived: true, readAt: 2_000 });

    const second = await saveItem({
      url: 'https://example.com/a?utm_source=twitter&fbclid=abc',
      title: 'Nowy tytul',
      tags: ['TypeScript'],
      savedAt: 5_000,
      wordCount: 800,
    });

    expect(second.id).toBe(first.id);
    await expect(countItems()).resolves.toBe(1);

    // metadane odswiezone
    expect(second.title).toBe('Nowy tytul');
    expect(second.wordCount).toBe(800);
    expect(second.estReadingMinutes).toBe(4);
    expect(second.savedAt).toBe(5_000);

    // stan uzytkownika nietkniety, tagi zsumowane
    expect(second.favorite).toBe(true);
    expect(second.archived).toBe(true);
    expect(second.readAt).toBe(2_000);
    expect(second.tags).toEqual(['rust', 'typescript']);
  });

  it('getItemByUrl znajduje pozycje mimo parametrow sledzacych', async () => {
    const saved = await saveItem({ url: 'https://example.com/a' });
    const found = await getItemByUrl('https://example.com/a?utm_campaign=x');

    expect(found?.id).toBe(saved.id);
  });
});

describe('listItems', () => {
  /** Cztery pozycje o rosnacym `savedAt`, zeby kolejnosc byla deterministyczna. */
  async function seed(): Promise<SavedItem[]> {
    const items: SavedItem[] = [];
    for (let i = 1; i <= 4; i += 1) {
      items.push(
        await saveItem({
          url: `https://example.com/${i}`,
          title: `Artykul ${i}`,
          savedAt: i * 1_000,
          tags: i % 2 === 0 ? ['rust'] : ['rust', 'web'],
        }),
      );
    }
    return items;
  }

  it('domyslnie sortuje od najnowszych', async () => {
    await seed();
    const page = await listItems();

    expect(page.items.map((item) => item.title)).toEqual([
      'Artykul 4',
      'Artykul 3',
      'Artykul 2',
      'Artykul 1',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('sortuje od najstarszych', async () => {
    await seed();
    const page = await listItems({ sort: 'oldest' });

    expect(page.items.map((item) => item.title)).toEqual([
      'Artykul 1',
      'Artykul 2',
      'Artykul 3',
      'Artykul 4',
    ]);
  });

  it('stronicuje kursorem bez gubienia i powtarzania pozycji', async () => {
    await seed();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Awaited<ReturnType<typeof listItems>> = await listItems({ limit: 2, cursor });
      seen.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(['Artykul 4', 'Artykul 3', 'Artykul 2', 'Artykul 1']);
    expect(new Set(seen).size).toBe(4);
    expect(pages).toBe(2);
  });

  it('stronicuje poprawnie takze przy identycznym savedAt', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await saveItem({ url: `https://example.com/rowne-${i}`, savedAt: 7_000 });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Awaited<ReturnType<typeof listItems>> = await listItems({ limit: 1, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(new Set(seen).size).toBe(3);
  });

  it('filtruje po stanie pozycji', async () => {
    const items = await seed();
    const [first, second] = items;
    if (first === undefined || second === undefined) throw new Error('brak danych testowych');

    await updateItem(first.id, { archived: true });
    await updateItem(second.id, { favorite: true, readAt: 9_000 });

    await expect(
      listItems({ filter: { archived: true } }).then((page) => page.items.length),
    ).resolves.toBe(1);
    await expect(
      listItems({ filter: { archived: false } }).then((page) => page.items.length),
    ).resolves.toBe(3);
    await expect(
      listItems({ filter: { favorite: true } }).then((page) => page.items[0]?.id),
    ).resolves.toBe(second.id);
    await expect(
      listItems({ filter: { unread: false } }).then((page) => page.items[0]?.id),
    ).resolves.toBe(second.id);
    await expect(
      listItems({ filter: { status: 'pending' } }).then((page) => page.items.length),
    ).resolves.toBe(4);
  });

  it('filtruje po tagach koniunkcyjnie', async () => {
    await seed();

    await expect(listItems({ filter: { tags: ['rust'] } }).then((p) => p.items.length)).resolves.toBe(
      4,
    );
    await expect(listItems({ filter: { tags: ['web'] } }).then((p) => p.items.length)).resolves.toBe(
      2,
    );
    await expect(
      listItems({ filter: { tags: ['rust', 'web'] } }).then((p) => p.items.length),
    ).resolves.toBe(2);
    await expect(
      listItems({ filter: { tags: ['rust', 'nie-ma'] } }).then((p) => p.items.length),
    ).resolves.toBe(0);
  });
});

describe('updateItem', () => {
  it('nadpisuje pola i utrzymuje klucz indeksu `archived`', async () => {
    const item = await saveItem({ url: 'https://example.com/a', title: 'A' });
    const updated = await updateItem(item.id, { archived: true, tags: [' Rust ', 'rust'] });

    expect(updated.archived).toBe(true);
    expect(updated.archivedKey).toBe(1);
    expect(updated.tags).toEqual(['rust']);
    // Zapytanie po indeksie potwierdza, ze klucz faktycznie sie zaktualizowal.
    await expect(countItems({ archived: true })).resolves.toBe(1);

    const back = await updateItem(item.id, { archived: false });
    expect(back.archivedKey).toBe(0);
    await expect(countItems({ archived: true })).resolves.toBe(0);
  });

  it('rzuca dla nieznanego id', async () => {
    await expect(updateItem('nie-ma-takiego', { favorite: true })).rejects.toThrow(/Nie ma pozycji/);
  });
});

describe('deleteItem', () => {
  it('kasuje pozycje razem z trescia i zaznaczeniami', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const other = await saveItem({ url: 'https://example.com/b' });

    await setContent(item.id, { html: '<p>tresc</p>', text: 'tresc' });
    await addHighlight({ itemId: item.id, text: 'raz', start: 0, end: 3 });
    await addHighlight({ itemId: item.id, text: 'dwa', start: 4, end: 7 });
    await setContent(other.id, { html: '<p>inna</p>', text: 'inna' });
    await addHighlight({ itemId: other.id, text: 'obce', start: 0, end: 4 });

    await expect(deleteItem(item.id)).resolves.toBe(true);

    await expect(getItem(item.id)).resolves.toBeUndefined();
    await expect(getContent(item.id)).resolves.toBeUndefined();
    await expect(listHighlights(item.id)).resolves.toEqual([]);

    // Sasiednia pozycja nietknieta.
    await expect(getContent(other.id)).resolves.toBeDefined();
    await expect(listHighlights(other.id)).resolves.toHaveLength(1);
  });

  it('zwraca false, gdy nie bylo czego kasowac', async () => {
    await expect(deleteItem('nie-ma-takiego')).resolves.toBe(false);
  });
});

describe('contents', () => {
  it('zapisuje tresc i w tej samej transakcji oznacza pozycje jako ready', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    expect(item.status).toBe('pending');

    const content = await setContent(item.id, {
      html: '<p>oczyszczony</p>',
      text: 'oczyszczony',
      contentHash: 'sha256-abc',
    });

    expect(content.itemId).toBe(item.id);
    await expect(getContent(item.id)).resolves.toMatchObject({
      html: '<p>oczyszczony</p>',
      text: 'oczyszczony',
    });

    const refreshed = await getItem(item.id);
    expect(refreshed?.status).toBe('ready');
    expect(refreshed?.contentHash).toBe('sha256-abc');
  });

  it('nie zapisuje tresci dla nieznanej pozycji', async () => {
    await expect(setContent('nie-ma-takiego', { html: '', text: '' })).rejects.toThrow(
      /Nie ma pozycji/,
    );
    await expect(getContent('nie-ma-takiego')).resolves.toBeUndefined();
  });
});

describe('highlights', () => {
  it('dodaje i zwraca zaznaczenia po itemId, w kolejnosci dodania', async () => {
    const item = await saveItem({ url: 'https://example.com/a' });
    const other = await saveItem({ url: 'https://example.com/b' });

    await addHighlight({ itemId: item.id, text: 'drugie', createdAt: 200, start: 10, end: 16 });
    await addHighlight({ itemId: item.id, text: 'pierwsze', createdAt: 100, note: 'notatka', start: 0, end: 8 });
    await addHighlight({ itemId: other.id, text: 'obce', createdAt: 150, start: 0, end: 4 });

    const highlights = await listHighlights(item.id);
    expect(highlights.map((h) => h.text)).toEqual(['pierwsze', 'drugie']);
    expect(highlights[0]?.note).toBe('notatka');
    expect(highlights[1]?.note).toBeNull();
  });

  it('nie dodaje zaznaczenia do nieznanej pozycji', async () => {
    await expect(addHighlight({ itemId: 'nie-ma-takiego', text: 'x', start: 0, end: 1 })).rejects.toThrow(
      /Nie ma pozycji/,
    );
  });
});

describe('countItems', () => {
  it('liczy calosc, stan i tagi', async () => {
    const a = await saveItem({ url: 'https://example.com/a', tags: ['rust'] });
    await saveItem({ url: 'https://example.com/b', tags: ['rust', 'web'] });
    await saveItem({ url: 'https://example.com/c' });
    await updateItem(a.id, { archived: true, favorite: true });

    await expect(countItems()).resolves.toBe(3);
    await expect(countItems({ archived: true })).resolves.toBe(1);
    await expect(countItems({ archived: false })).resolves.toBe(2);
    await expect(countItems({ tags: ['rust'] })).resolves.toBe(2);
    await expect(countItems({ tags: ['rust'], archived: false })).resolves.toBe(1);
    await expect(countItems({ favorite: true, tags: ['rust'] })).resolves.toBe(1);
  });
});

describe('migracje', () => {
  /** Rekord w ksztalcie sprzed wersji 2 - typy opisuja terazniejszosc, nie historie. */
  function withoutFields<T extends Record<string, unknown>>(value: T, fields: readonly string[]): T {
    const record: Record<string, unknown> = { ...value };
    for (const field of fields) delete record[field];
    return record as T;
  }

  function sampleItem(id: string, title: string): SavedItem {
    return {
      id,
      url: `https://example.com/${id}`,
      resolvedUrl: `https://example.com/${id}`,
      title,
      excerpt: 'zajawka',
      byline: null,
      siteName: null,
      lang: 'pl',
      wordCount: 100,
      estReadingMinutes: 1,
      savedAt: 1_000,
      updatedAt: 1_000,
      readAt: null,
      archived: false,
      favorite: true,
      tags: ['rust'],
      contentHash: 'sha256-a',
      status: 'ready',
      readingProgress: 0,
      archivedKey: 0,
    };
  }

  it('realna migracja 1 -> 2 doklada pola i nie rusza danych', async () => {
    // --- baza w wersji 1, rekordy bez pol z wersji 2 ---
    const v1 = await openDb({ version: 1 });
    const item = sampleItem('stary-1', 'Pierwszy');
    await v1.put('items', withoutFields({ ...item }, ['readingProgress']));
    await v1.put('contents', { itemId: item.id, html: '<p>x</p>', text: 'x', updatedAt: 5 });
    await v1.put(
      'highlights',
      withoutFields(
        {
          id: 'h1',
          itemId: item.id,
          text: 'cytat',
          note: 'notatka',
          createdAt: 7,
          start: 0,
          end: 0,
          prefix: '',
          suffix: '',
        },
        ['start', 'end', 'prefix', 'suffix'],
      ),
    );
    v1.close();

    // --- pierwsze uzycie API podnosi wersje do 2 ---
    const migrated = await getItem(item.id);
    expect(migrated?.readingProgress).toBe(0);
    expect(migrated?.title).toBe('Pierwszy');
    expect(migrated?.favorite).toBe(true);
    expect(migrated?.tags).toEqual(['rust']);
    expect(migrated?.contentHash).toBe('sha256-a');

    await expect(getContent(item.id)).resolves.toMatchObject({ text: 'x' });

    const [highlight] = await listHighlights(item.id);
    expect(highlight).toMatchObject({ text: 'cytat', note: 'notatka', start: 0, end: 0, prefix: '' });
  });

  /** Sztuczna wersja 5: dokladamy pole do kazdej pozycji, nic nie kasujac. */
  const addFlag: Migration = async (_db, tx) => {
    const store = tx.objectStore('items');
    let cursor = await store.openCursor();
    while (cursor !== null) {
      const migrated = { ...cursor.value, przypiete: false };
      await cursor.update(migrated);
      cursor = await cursor.continue();
    }
  };

  it('podniesienie wersji 4 -> 5 doklada pole i nie kasuje danych', async () => {
    const first = await saveItem({
      url: 'https://example.com/a',
      title: 'Pierwszy',
      tags: ['rust'],
      savedAt: 1_000,
    });
    const second = await saveItem({
      url: 'https://example.com/b',
      title: 'Drugi',
      savedAt: 2_000,
    });
    await updateItem(second.id, { archived: true, favorite: true, readAt: 3_000 });
    await setContent(first.id, { html: '<p>tresc</p>', text: 'tresc', contentHash: 'sha256-a' });
    await addHighlight({ itemId: first.id, text: 'zaznaczenie', createdAt: 500, start: 2, end: 13 });

    await closeDb();

    const db = await openDb({ version: 5, migrations: { 5: addFlag } });

    try {
      expect(db.version).toBe(5);
      expect([...db.objectStoreNames].sort()).toEqual([
        'contents',
        'highlights',
        'items',
        'snapshots',
        'tombstones',
      ]);

      const items = (await db.getAll('items')) as (SavedItem & { przypiete?: boolean })[];
      expect(items).toHaveLength(2);

      const migratedFirst = items.find((entry) => entry.id === first.id);
      const migratedSecond = items.find((entry) => entry.id === second.id);

      expect(migratedFirst?.przypiete).toBe(false);
      expect(migratedSecond?.przypiete).toBe(false);

      expect(migratedFirst?.title).toBe('Pierwszy');
      expect(migratedFirst?.tags).toEqual(['rust']);
      expect(migratedFirst?.status).toBe('ready');
      expect(migratedFirst?.readingProgress).toBe(0);
      expect(migratedSecond?.archived).toBe(true);
      expect(migratedSecond?.readAt).toBe(3_000);

      await expect(db.get('contents', first.id)).resolves.toMatchObject({ text: 'tresc' });
      const highlights = await db.getAllFromIndex('highlights', 'itemId', first.id);
      expect(highlights).toHaveLength(1);
      expect(highlights[0]).toMatchObject({ start: 2, end: 13 });

      const tx = db.transaction('items', 'readonly');
      expect([...tx.store.indexNames].sort()).toEqual(['archived', 'savedAt', 'tags', 'url']);
      await expect(tx.store.index('archived').count(1)).resolves.toBe(1);
      await expect(tx.store.index('tags').count('rust')).resolves.toBe(1);
      await tx.done;
    } finally {
      db.close();
    }
  });

  it('brak migracji do zadanej wersji przerywa upgrade zamiast psuc schemat', async () => {
    await saveItem({ url: 'https://example.com/a', title: 'Zostaje' });
    await closeDb();

    await expect(openDb({ version: 5, migrations: {} })).rejects.toThrow();

    // Dane wciaz na miejscu.
    await expect(countItems()).resolves.toBe(1);
  });
});

describe('exportAll', () => {
  it('oddaje spojny zrzut trzech magazynow, najnowsze pozycje pierwsze', async () => {
    const stary = await saveItem({ url: 'https://a.example/1', savedAt: 1_000 });
    const nowy = await saveItem({ url: 'https://b.example/2', savedAt: 2_000 });
    await setContent(stary.id, { html: '<p>a</p>', text: 'a' });
    await addHighlight({ itemId: nowy.id, text: 'cytat', start: 0, end: 5 });

    const dump = await exportAll();

    expect(dump.items.map((item) => item.url)).toEqual([
      'https://b.example/2',
      'https://a.example/1',
    ]);
    expect(dump.contents).toHaveLength(1);
    expect(dump.highlights).toHaveLength(1);
  });

  it('listAllItems daje same metadane, bez tresci', async () => {
    const item = await saveItem({ url: 'https://a.example/1' });
    await setContent(item.id, { html: '<p>a</p>', text: 'a' });

    const items = await listAllItems();
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {})).not.toContain('html');
  });
});

describe('importDump', () => {
  /** Minimalna pozycja w ksztalcie rekordu z pliku kopii. */
  function record(url: string, overrides: Partial<SavedItem> = {}): SavedItem {
    return {
      id: `plik-${url}`,
      url: normalizeUrl(url),
      resolvedUrl: url,
      title: 'Z pliku',
      excerpt: '',
      byline: null,
      siteName: null,
      lang: null,
      wordCount: 100,
      estReadingMinutes: 1,
      savedAt: 1_000,
      updatedAt: 1_000,
      readAt: null,
      archived: false,
      favorite: false,
      tags: [],
      contentHash: null,
      status: 'ready',
      readingProgress: 0,
      archivedKey: 0,
      ...overrides,
    };
  }

  it('dodaje nowe pozycje razem z trescia i zaznaczeniami', async () => {
    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [
        { itemId: 'plik-https://a.example/1', html: '<p>a</p>', text: 'a', updatedAt: 1_000 },
      ],
      highlights: [
        {
          id: 'h1',
          itemId: 'plik-https://a.example/1',
          text: 'cytat',
          note: null,
          createdAt: 1_000,
          start: 0,
          end: 5,
          prefix: '',
          suffix: '',
        },
      ],
    });

    expect(outcome).toMatchObject({ added: 1, merged: 0, contents: 1, highlights: 1, skipped: 0 });

    const item = await getItemByUrl('https://a.example/1');
    expect(item).toBeDefined();
    expect((await getContent(item?.id ?? ''))?.html).toBe('<p>a</p>');
    expect(await listHighlights(item?.id ?? '')).toHaveLength(1);
  });

  it('scala po znormalizowanym adresie zamiast dublowac', async () => {
    await saveItem({ url: 'https://a.example/1?utm_source=nl', tags: ['lokalny'] });

    const outcome = await importDump({
      items: [record('https://a.example/1', { tags: ['z-pliku'] })],
      contents: [],
      highlights: [],
    });

    expect(outcome).toMatchObject({ added: 0, merged: 1 });
    expect(await countItems()).toBe(1);
    expect((await getItemByUrl('https://a.example/1'))?.tags).toEqual(['lokalny', 'z-pliku']);
  });

  it('scalanie doklada, ale nie odbiera stanu uzytkownika', async () => {
    const local = await saveItem({ url: 'https://a.example/1', title: 'Lokalny tytul' });
    await updateItem(local.id, { archived: true, readAt: 5_000 });

    await importDump({
      items: [
        record('https://a.example/1', {
          title: 'Tytul z pliku',
          archived: false,
          favorite: true,
          readAt: null,
          savedAt: 500,
        }),
      ],
      contents: [],
      highlights: [],
    });

    const merged = await getItem(local.id);
    // Stan po tej stronie zostaje, plik dorzuca tylko to, czego brakowalo.
    expect(merged?.archived).toBe(true);
    expect(merged?.readAt).toBe(5_000);
    expect(merged?.title).toBe('Lokalny tytul');
    expect(merged?.favorite).toBe(true);
    expect(merged?.savedAt).toBe(500);
  });

  it('nie nadpisuje tresci, ktora juz mamy, i liczy to jako pominiete', async () => {
    const local = await saveItem({ url: 'https://a.example/1' });
    await setContent(local.id, { html: '<p>lokalna</p>', text: 'lokalna' });

    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [
        { itemId: 'plik-https://a.example/1', html: '<p>z pliku</p>', text: 'x', updatedAt: 9_000 },
      ],
      highlights: [],
    });

    expect(outcome.contents).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect((await getContent(local.id))?.html).toBe('<p>lokalna</p>');
  });

  it('nie dubluje zaznaczen o tym samym cytacie i offsetach', async () => {
    const local = await saveItem({ url: 'https://a.example/1' });
    await addHighlight({ itemId: local.id, text: 'cytat', start: 0, end: 5 });

    const outcome = await importDump({
      items: [record('https://a.example/1')],
      contents: [],
      highlights: [
        {
          id: 'inne-id',
          itemId: 'plik-https://a.example/1',
          text: 'cytat',
          note: null,
          createdAt: 1_000,
          start: 0,
          end: 5,
          prefix: '',
          suffix: '',
        },
      ],
    });

    expect(outcome.highlights).toBe(0);
    expect(outcome.skipped).toBe(1);
    expect(await listHighlights(local.id)).toHaveLength(1);
  });

  it('kolizja identyfikatora nie nadpisuje cudzej pozycji', async () => {
    const local = await saveItem({ url: 'https://a.example/stary' });

    await importDump({
      items: [record('https://b.example/nowy', { id: local.id })],
      contents: [],
      highlights: [],
    });

    expect(await countItems()).toBe(2);
    expect((await getItem(local.id))?.url).toBe('https://a.example/stary');
    expect(await getItemByUrl('https://b.example/nowy')).toBeDefined();
  });

  it('blad w polowie nie zostawia polowy importu', async () => {
    // Rekord z polem, ktorego strukturalny klon nie przepusci - transakcja
    // musi sie wycofac razem z pozycjami zapisanymi przed nim.
    const trefny = record('https://c.example/3') as SavedItem & { zly?: unknown };
    trefny.zly = () => undefined;

    await expect(
      importDump({
        items: [record('https://a.example/1'), record('https://b.example/2'), trefny],
        contents: [],
        highlights: [],
      }),
    ).rejects.toThrow();

    expect(await countItems()).toBe(0);
  });
});

describe('snapshots', () => {
  it('kopiuja metadane i trzymaja tylko ostatnie SNAPSHOT_LIMIT', async () => {
    await saveItem({ url: 'https://a.example/1' });

    for (let i = 0; i < SNAPSHOT_LIMIT + 2; i += 1) {
      await createSnapshot(10_000 + i);
    }

    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(SNAPSHOT_LIMIT);
    // Najnowsza na gorze, najstarsze wypchniete.
    expect(snapshots[0]?.createdAt).toBe(10_000 + SNAPSHOT_LIMIT + 1);
    expect(snapshots[0]?.itemCount).toBe(1);
  });

  it('kopia dobowa nie powtarza sie czesciej niz raz na SNAPSHOT_INTERVAL_MS', async () => {
    await saveItem({ url: 'https://a.example/1' });
    const now = 1_000_000_000;

    expect(await createSnapshotIfDue(now)).not.toBeNull();
    expect(await createSnapshotIfDue(now + 60_000)).toBeNull();
    expect(await createSnapshotIfDue(now + SNAPSHOT_INTERVAL_MS + 1)).not.toBeNull();
    expect(await listSnapshots()).toHaveLength(2);
  });

  it('pusta baza nie zasluguje na kopie', async () => {
    expect(await createSnapshotIfDue(1_000)).toBeNull();
    expect(await listSnapshots()).toHaveLength(0);
  });

  it('przywrocenie doklada skasowane pozycje i nie rusza reszty', async () => {
    const skasowany = await saveItem({ url: 'https://a.example/1', tags: ['rust'] });
    await saveItem({ url: 'https://b.example/2' });
    await createSnapshot(10_000);

    await deleteItem(skasowany.id);
    const pozniejszy = await saveItem({ url: 'https://c.example/3' });

    const [snapshot] = await listSnapshots();
    const outcome = await restoreSnapshot(snapshot?.id ?? '');

    expect(outcome).toMatchObject({ added: 1, merged: 1 });
    expect((await getItemByUrl('https://a.example/1'))?.tags).toEqual(['rust']);
    // Kopia jest starsza niz ta pozycja - przywracanie nie moze jej ruszyc.
    expect(await getItem(pozniejszy.id)).toBeDefined();
    expect(await countItems()).toBe(3);
  });

  it('przywracanie nieistniejacej kopii to blad, nie cicha porazka', async () => {
    await expect(restoreSnapshot('nie-ma-takiej')).rejects.toThrow(/Nie ma kopii/);
  });
});

describe('dataStats i clearAllData', () => {
  it('licza to, co widac na stronie opcji', async () => {
    const pierwszy = await saveItem({ url: 'https://a.example/1' });
    const drugi = await saveItem({ url: 'https://b.example/2' });
    await setContent(pierwszy.id, { html: '<p>a</p>', text: 'a' });
    await addHighlight({ itemId: pierwszy.id, text: 'cytat', start: 0, end: 5 });
    await updateItem(drugi.id, { archived: true, favorite: true, readAt: 1_000 });
    await createSnapshot(10_000);

    expect(await dataStats()).toEqual({
      items: 2,
      unread: 1,
      archived: 1,
      favorite: 1,
      contents: 1,
      highlights: 1,
      snapshots: 1,
    });
  });

  it('kasowanie czysci wszystko, a baza dziala dalej', async () => {
    const item = await saveItem({ url: 'https://a.example/1' });
    await setContent(item.id, { html: '<p>a</p>', text: 'a' });
    await createSnapshot(10_000);

    await clearAllData();

    expect(await dataStats()).toMatchObject({ items: 0, contents: 0, snapshots: 0 });
    await expect(saveItem({ url: 'https://b.example/2' })).resolves.toBeDefined();
  });
});
