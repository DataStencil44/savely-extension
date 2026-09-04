/**
 * Warstwa przechowywania: IndexedDB przez `idb`.
 *
 * Baza `savely`, piec magazynow:
 *   items      - metadane pozycji (lekkie, ladowane do listy)
 *   contents   - oczyszczony HTML + plain text, osobno i celowo:
 *                lista nie moze wciagac megabajtow tresci, zeby sie otworzyc
 *   highlights - zaznaczenia w tresci, powiazane przez itemId
 *   snapshots  - automatyczne kopie METADANYCH (bez tresci), ostatnie trzy
 *   tombstones - slady po skasowanych pozycjach, pod synchronizacje
 *
 * IndexedDB jest jedynym zrodlem prawdy dla danych (CLAUDE.md 4.3);
 * `storage.local` zostaje na drobne ustawienia UI.
 */
import {
  openDB,
  deleteDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

import { estimateReadingMinutes } from '@/types/article';

// ---------------------------------------------------------------------------
// Typy domenowe
// ---------------------------------------------------------------------------

export type ItemStatus = 'pending' | 'ready' | 'failed';

export interface SavedItem {
  id: string;
  /**
   * Adres znormalizowany (bez parametrow sledzacych) - klucz deduplikacji
   * i unikalny indeks `url`.
   */
  url: string;
  /** Adres oryginalny, dokladnie taki, jaki przyszedl z karty. */
  resolvedUrl: string;
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  wordCount: number;
  estReadingMinutes: number;
  savedAt: number;
  /**
   * Ostatnia zmiana czegokolwiek w tym rekordzie. Ustawiane przez **kazda**
   * sciezke zapisu - to po nim synchronizacja rozstrzyga konflikty (kto
   * zapisal pozniej, ten wygrywa), wiec pole nieaktualne = zmiana przepadnie
   * przy nastepnym scaleniu.
   */
  updatedAt: number;
  readAt: number | null;
  archived: boolean;
  favorite: boolean;
  tags: string[];
  contentHash: string | null;
  status: ItemStatus;
  /** Ile artykulu przewinieto, 0..1. Czytnik zapisuje, lista moze pokazac. */
  readingProgress: number;
  /**
   * Pochodna `archived` (0/1). IndexedDB nie indeksuje booleanow - rekordy
   * z kluczem `false`/`true` po prostu nie trafilyby do indeksu. Utrzymywane
   * automatycznie przez kazda sciezke zapisu; nie ustawiaj recznie.
   */
  archivedKey: 0 | 1;
}

export interface ItemContent {
  itemId: string;
  /** HTML po DOMPurify - nigdy surowy HTML ze strony. */
  html: string;
  /** Ta sama tresc jako czysty tekst; zrodlo dla indeksu wyszukiwania. */
  text: string;
  updatedAt: number;
}

/**
 * Zaznaczenie zakotwiczone w **tekscie**, nie w strukturze HTML.
 *
 * `start`/`end` to offsety w czystym tekscie artykulu, a `prefix`/`suffix` to
 * kilkadziesiat znakow kontekstu. Gdy tresc lekko sie przesunie (inny podzial
 * akapitow, doklejona zajawka), offsety przestaja pasowac, ale cytat plus
 * kontekst wciaz pozwalaja znalezc miejsce - czego XPath by nie przezyl.
 */
export interface Highlight {
  id: string;
  itemId: string;
  /** Zaznaczony tekst - zarazem tresc do odtworzenia i do skopiowania. */
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

/**
 * Automatyczna kopia metadanych. Swiadomie BEZ `contents` - tresci artykulow
 * to megabajty, a trzy ich kopie w tej samej bazie zjadalyby limit dysku
 * szybciej niz cokolwiek innego. Snapshot ratuje to, czego nie da sie odtworzyc
 * ponownym zapisem strony: tagi, ulubione, stan archiwum, daty.
 */
export interface Snapshot {
  id: string;
  createdAt: number;
  itemCount: number;
  items: SavedItem[];
}

/** Wiersz listy kopii - bez `items`, zeby UI nie wciagalo calej bazy. */
export type SnapshotSummary = Omit<Snapshot, 'items'>;

/**
 * Slad po skasowanej pozycji. Bez niego synchronizacja bylaby jednokierunkowa:
 * pozycja skasowana na jednym urzadzeniu wracalaby z drugiego przy najblizszym
 * scaleniu. Kluczem jest znormalizowany adres, bo `id` bywa rozne na roznych
 * urzadzeniach.
 */
export interface Tombstone {
  url: string;
  deletedAt: number;
}

export interface SavelyDB extends DBSchema {
  items: {
    key: string;
    value: SavedItem;
    indexes: {
      savedAt: number;
      /** keyPath: `archivedKey` - patrz komentarz przy polu. */
      archived: number;
      url: string;
      tags: string;
    };
  };
  contents: {
    key: string;
    value: ItemContent;
  };
  highlights: {
    key: string;
    value: Highlight;
    indexes: { itemId: string };
  };
  snapshots: {
    key: string;
    value: Snapshot;
    indexes: { createdAt: number };
  };
  tombstones: {
    key: string;
    value: Tombstone;
  };
}

// ---------------------------------------------------------------------------
// Normalizacja URL-a
// ---------------------------------------------------------------------------

/** Parametry czysto sledzace - nie zmieniaja tresci, wiec psuja deduplikacje. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref']);
const TRACKING_PREFIX = 'utm_';

/**
 * Sprowadza adres do postaci porownywalnej: wycina `utm_*`, `fbclid`, `gclid`
 * i `ref`. Reszta (sciezka, pozostale parametry, fragment) zostaje bez zmian -
 * dla wielu stron fragment albo `?p=123` to jedyny identyfikator artykulu.
 *
 * Adres nie do sparsowania wraca przycienty, ale nietkniety: lepiej zapisac
 * cos dziwnego niz wywalic zapis.
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  const params = parsed.searchParams;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(lower)) {
      params.delete(key);
    }
  }

  const query = params.toString();
  parsed.search = query === '' ? '' : `?${query}`;
  return parsed.toString();
}

/** Tagi trzymamy w jednej postaci, zeby indeks multiEntry byl przewidywalny. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Schemat i migracje
// ---------------------------------------------------------------------------

export const DB_NAME = 'savely';
export const DB_VERSION = 4;

type UpgradeTransaction = IDBPTransaction<SavelyDB, StoreNames<SavelyDB>[], 'versionchange'>;

export type Migration = (
  db: IDBPDatabase<SavelyDB>,
  tx: UpgradeTransaction,
) => void | Promise<void>;

/** Wersja 1: pelny schemat od zera. */
const createSchemaV1: Migration = (db) => {
  const items = db.createObjectStore('items', { keyPath: 'id' });
  items.createIndex('savedAt', 'savedAt');
  items.createIndex('archived', 'archivedKey');
  items.createIndex('url', 'url', { unique: true });
  items.createIndex('tags', 'tags', { multiEntry: true });

  db.createObjectStore('contents', { keyPath: 'itemId' });

  const highlights = db.createObjectStore('highlights', { keyPath: 'id' });
  highlights.createIndex('itemId', 'itemId');
};

/** Ksztalt rekordow sprzed wersji 2 - pola dochodza dopiero w migracji. */
type LegacyItem = Omit<SavedItem, 'readingProgress'> & { readingProgress?: number };
type LegacyHighlight = Omit<Highlight, 'start' | 'end' | 'prefix' | 'suffix'> &
  Partial<Pick<Highlight, 'start' | 'end' | 'prefix' | 'suffix'>>;

/**
 * Wersja 2: postep czytania na pozycjach i kotwice tekstowe na zaznaczeniach.
 * Migracja tylko **dokłada** pola z wartosciami domyslnymi - zaden istniejacy
 * rekord nie jest kasowany ani nadpisywany.
 */
const migrateToV2: Migration = async (_db, tx) => {
  const items = tx.objectStore('items');
  let item = await items.openCursor();
  while (item !== null) {
    const value = item.value as LegacyItem;
    if (typeof value.readingProgress !== 'number') {
      await item.update({ ...value, readingProgress: 0 });
    }
    item = await item.continue();
  }

  const highlights = tx.objectStore('highlights');
  let highlight = await highlights.openCursor();
  while (highlight !== null) {
    const value = highlight.value as LegacyHighlight;
    if (typeof value.start !== 'number') {
      // Bez offsetow zostaje sam cytat - `locate` i tak potrafi go odnalezc.
      await highlight.update({ ...value, start: 0, end: 0, prefix: '', suffix: '' });
    }
    highlight = await highlight.continue();
  }
};

/**
 * Wersja 3: magazyn automatycznych kopii metadanych. Sam magazyn, zero
 * przepisywania istniejacych rekordow - pierwsza kopia powstanie z alarmu.
 */
const migrateToV3: Migration = (db) => {
  const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
  snapshots.createIndex('createdAt', 'createdAt');
};

/** Ksztalt rekordow sprzed wersji 4. */
type LegacyItemV3 = Omit<SavedItem, 'updatedAt'> & { updatedAt?: number };

/**
 * Wersja 4: `updatedAt` na pozycjach i magazyn grobow - jedno i drugie pod
 * synchronizacje. Istniejace rekordy dostaja `updatedAt` rowne `savedAt`:
 * pierwsze scalenie potraktuje je jak zmiany z chwili zapisu, czyli
 * najlagodniej, jak sie da.
 */
const migrateToV4: Migration = async (db, tx) => {
  db.createObjectStore('tombstones', { keyPath: 'url' });

  const items = tx.objectStore('items');
  let cursor = await items.openCursor();
  while (cursor !== null) {
    const value = cursor.value as LegacyItemV3;
    if (typeof value.updatedAt !== 'number') {
      await cursor.update({ ...value, updatedAt: value.savedAt });
    }
    cursor = await cursor.continue();
  }
};

/**
 * Jawny switch po wersjach - jedyne miejsce, do ktorego dopisujemy migracje.
 * Kazda kolejna wersja to nowy `case`, ktory dostaje baze juz po poprzednich
 * krokach (patrz petla w `runMigrations`), wiec migracje sa przyrostowe
 * i nigdy nie odtwarzaja schematu od zera na istniejacych danych.
 */
function migrationFor(version: number): Migration | undefined {
  switch (version) {
    case 1:
      return createSchemaV1;
    case 2:
      return migrateToV2;
    case 3:
      return migrateToV3;
    case 4:
      return migrateToV4;
    default:
      return undefined;
  }
}

/**
 * Wykonuje po kolei migracje od `oldVersion + 1` do `newVersion`.
 *
 * Celowo nie jest `async`: pierwszy krok musi ruszyc synchronicznie, jeszcze
 * w obsludze `upgradeneeded`. Po `await` transakcja versionchange bywa juz
 * nieaktywna dla operacji schematowych, a wtedy `createObjectStore` wybucha.
 * Kolejne kroki (migracje danych) ida lancuchem i czekaja tylko na zadania
 * IndexedDB, co trzyma transakcje przy zyciu.
 *
 * Brak migracji dla wersji = blad, a nie ciche pominiecie - inaczej schemat
 * rozjechalby sie z kodem i dowiedzielibysmy sie o tym dopiero na produkcji.
 */
function runMigrations(
  db: IDBPDatabase<SavelyDB>,
  tx: UpgradeTransaction,
  oldVersion: number,
  newVersion: number,
  overrides: Record<number, Migration> | undefined,
): Promise<void> {
  const steps: Migration[] = [];
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migration = overrides?.[version] ?? migrationFor(version);
    if (migration === undefined) {
      return Promise.reject(new Error(`Brak migracji bazy "${DB_NAME}" do wersji ${version}.`));
    }
    steps.push(migration);
  }

  let chain: Promise<void> | null = null;
  for (const step of steps) {
    chain = chain === null ? Promise.resolve(step(db, tx)) : chain.then(() => step(db, tx));
  }
  return chain ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// Polaczenie
// ---------------------------------------------------------------------------

export interface OpenDbOptions {
  /** Nadpisanie wersji - do testow migracji. */
  version?: number;
  /** Nadpisanie/uzupelnienie migracji - do testow migracji. */
  migrations?: Record<number, Migration>;
}

/**
 * Cache polaczenia. Przezywa tylko tyle, co modul: po uspieniu service workera
 * (CLAUDE.md 5.5) startujemy od nowa i to jest w porzadku - to cache, nie stan.
 */
let connection: Promise<IDBPDatabase<SavelyDB>> | null = null;

/**
 * Otwiera baze. Bez argumentow zwraca wspoldzielone, cache'owane polaczenie.
 * Z `options` otwiera polaczenie jednorazowe (nie cache'owane) - tak testujemy
 * migracje, nie dotykajac stanu reszty aplikacji.
 */
export async function openDb(options?: OpenDbOptions): Promise<IDBPDatabase<SavelyDB>> {
  const version = options?.version ?? DB_VERSION;
  const overrides = options?.migrations;

  const open = (): Promise<IDBPDatabase<SavelyDB>> =>
    openDB<SavelyDB>(DB_NAME, version, {
      upgrade(db, oldVersion, newVersion, tx) {
        runMigrations(db, tx, oldVersion, newVersion ?? version, overrides).catch(
          (error: unknown) => {
            // Przerwana transakcja versionchange = otwarcie bazy konczy sie
            // bledem i zostajemy na starej wersji. Lepsze niz polowa schematu.
            console.error('[savely] migracja bazy nie powiodla sie:', error);
            // Po `abort()` odrzuci sie takze `tx.done`; przejmujemy je tutaj,
            // zeby nie zostawic nieobsluzonego odrzucenia w tle.
            void tx.done.catch(() => undefined);
            try {
              tx.abort();
            } catch {
              // Transakcja mogla juz sama wyladowac w bledzie - nic nie robimy.
            }
          },
        );
      },
      blocking() {
        // Inny kontekst chce podniesc wersje - oddajemy polaczenie, zeby
        // upgrade nie utknal na `blocked`.
        void closeDb();
      },
    });

  if (options !== undefined) return open();

  connection ??= open();
  return connection;
}

/** Zamyka wspoldzielone polaczenie (testy, reset po migracji). */
export async function closeDb(): Promise<void> {
  const pending = connection;
  connection = null;
  if (pending === null) return;
  (await pending).close();
}

/** Kasuje cala baze. Uzywane w testach i przez przyszle "usun moje dane". */
export async function deleteDb(): Promise<void> {
  await closeDb();
  await deleteDB(DB_NAME);
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

export interface SaveItemInput {
  /** Adres strony (oryginal). */
  url: string;
  /** Adres po przekierowaniach, jesli inny niz `url`. */
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
  /** Do testow i importu - domyslnie `Date.now()`. */
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

export interface ItemFilter {
  archived?: boolean;
  favorite?: boolean;
  /** `true` = tylko nieprzeczytane (`readAt === null`). */
  unread?: boolean;
  status?: ItemStatus;
  /** Koniunkcja - pozycja musi miec wszystkie podane tagi. */
  tags?: string[];
}

export type ItemSort = 'newest' | 'oldest';

export interface ListItemsOptions {
  filter?: ItemFilter;
  sort?: ItemSort;
  limit?: number;
  /** Token z poprzedniej strony (`nextCursor`). */
  cursor?: string | null;
}

export interface ItemPage {
  items: SavedItem[];
  /** `null` = koniec listy. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;

/** Utrzymuje pola pochodne (klucz indeksu) w jednym miejscu. */
function withDerived(item: Omit<SavedItem, 'archivedKey'>): SavedItem {
  return { ...item, archivedKey: item.archived ? 1 : 0 };
}

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
    // Jawny `savedAt` oznacza rekord historyczny (import, odtworzenie stanu),
    // wiec i ostatnia zmiana jest historyczna - inaczej stary wpis wygrywalby
    // przy synchronizacji z nowszymi danymi po drugiej stronie.
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

/**
 * Ponowny zapis znanego adresu odswieza metadane i podnosi `savedAt` (pozycja
 * wraca na gore listy), ale NIE dotyka stanu uzytkownika: `archived`,
 * `favorite` i `readAt` zostaja, a tagi sa sumowane, nie nadpisywane.
 */
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

/**
 * Zapisuje pozycje albo odswieza istniejaca o tym samym (znormalizowanym)
 * adresie. Wyszukanie duplikatu i zapis dziela jedna transakcje, wiec dwa
 * rownolegle zapisy tego samego URL-a nie zrobia dwoch wpisow.
 */
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

/** Pozycja po adresie - adres jest normalizowany, wiec `?utm_*` nie przeszkadza. */
export async function getItemByUrl(url: string): Promise<SavedItem | undefined> {
  const db = await openDb();
  return db.getFromIndex('items', 'url', normalizeUrl(url));
}

function encodeCursor(item: SavedItem): string {
  return `${item.savedAt}|${item.id}`;
}

function decodeCursor(token: string): { savedAt: number; id: string } | null {
  const separator = token.indexOf('|');
  if (separator <= 0) return null;
  const savedAt = Number(token.slice(0, separator));
  const id = token.slice(separator + 1);
  if (!Number.isFinite(savedAt) || id === '') return null;
  return { savedAt, id };
}

function matchesFilter(
  item: SavedItem,
  filter: ItemFilter,
  allowedIds: Set<string> | null,
): boolean {
  if (allowedIds !== null && !allowedIds.has(item.id)) return false;
  if (filter.archived !== undefined && item.archived !== filter.archived) return false;
  if (filter.favorite !== undefined && item.favorite !== filter.favorite) return false;
  if (filter.unread !== undefined && (item.readAt === null) !== filter.unread) return false;
  if (filter.status !== undefined && item.status !== filter.status) return false;
  return true;
}

/**
 * Zbior id pasujacych do wszystkich tagow, liczony z indeksu multiEntry.
 * `null` = brak filtra po tagach (nie zawezamy).
 */
async function idsForTags(
  tx: IDBPTransaction<SavelyDB, ['items'], 'readonly' | 'readwrite'>,
  tags: readonly string[],
): Promise<Set<string> | null> {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return null;

  const index = tx.objectStore('items').index('tags');
  let result: Set<string> | null = null;
  for (const tag of normalized) {
    // Jawna adnotacja: przy unii trybow transakcji idb gubi typ klucza.
    const tagged: string[] = await index.getAllKeys(tag);
    const keys = new Set<string>(tagged);

    if (result === null) {
      result = keys;
    } else {
      const intersection = new Set<string>();
      for (const id of result) {
        if (keys.has(id)) intersection.add(id);
      }
      result = intersection;
    }
    if (result.size === 0) break;
  }
  return result;
}

/**
 * Strona listy, sortowana po `savedAt` z indeksu i paginowana keysetem
 * (`savedAt` + `id`), nie offsetem - dopisanie pozycji w trakcie przewijania
 * nie przesuwa okna i nie gubi wierszy.
 */
export async function listItems(options: ListItemsOptions = {}): Promise<ItemPage> {
  const filter = options.filter ?? {};
  const sort = options.sort ?? 'newest';
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const cursorToken = options.cursor ?? null;
  const from = cursorToken === null ? null : decodeCursor(cursorToken);

  const db = await openDb();
  const tx = db.transaction('items', 'readonly');
  const allowedIds = await idsForTags(tx, filter.tags ?? []);
  const index = tx.store.index('savedAt');

  const direction: IDBCursorDirection = sort === 'newest' ? 'prev' : 'next';
  const range =
    from === null
      ? null
      : sort === 'newest'
        ? IDBKeyRange.upperBound(from.savedAt)
        : IDBKeyRange.lowerBound(from.savedAt);

  const items: SavedItem[] = [];
  let skipping = from !== null;
  let cursor = await index.openCursor(range, direction);

  while (cursor !== null && items.length < limit) {
    const item = cursor.value;

    if (skipping && from !== null) {
      if (item.savedAt !== from.savedAt) {
        // Wyszlismy poza blok o tym samym `savedAt` - dalej juz nie pomijamy.
        skipping = false;
      } else if (sort === 'newest' ? item.id >= from.id : item.id <= from.id) {
        cursor = await cursor.continue();
        continue;
      } else {
        skipping = false;
      }
    }

    if (matchesFilter(item, filter, allowedIds)) items.push(item);
    cursor = await cursor.continue();
  }

  await tx.done;

  // Kursor oddajemy tylko wtedy, gdy w indeksie zostalo cos niezobaczonego.
  const last = items[items.length - 1];
  const nextCursor =
    cursor !== null && last !== undefined && items.length === limit ? encodeCursor(last) : null;

  return { items, nextCursor };
}

/** Nadpisuje wskazane pola. Adresu nie da sie zmienic - trzyma dedup w ryzach. */
export async function updateItem(id: string, patch: ItemPatch): Promise<SavedItem> {
  const db = await openDb();
  const tx = db.transaction('items', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing === undefined) {
    await tx.done;
    throw new Error(`Nie ma pozycji o id ${id}.`);
  }

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

/**
 * Kasuje pozycje razem z trescia i zaznaczeniami - wszystko w jednej
 * transakcji, zeby nie zostaly osierocone rekordy w `contents`/`highlights`.
 * Zwraca `false`, gdy pozycji nie bylo.
 */
export async function deleteItem(id: string): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');
  const existing = await tx.objectStore('items').get(id);

  if (existing !== undefined) {
    await tx.objectStore('items').delete(id);
    await tx.objectStore('contents').delete(id);
    const highlights = tx.objectStore('highlights').index('itemId');
    let cursor = await highlights.openCursor(IDBKeyRange.only(id));
    while (cursor !== null) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    // Grob w tej samej transakcji, co kasowanie - inaczej przerwanie miedzy
    // nimi zostawiloby usuniecie, o ktorym synchronizacja nigdy by sie nie
    // dowiedziala, i pozycja wrocilaby z drugiego urzadzenia.
    await tx.objectStore('tombstones').put({ url: existing.url, deletedAt: Date.now() });
  }

  await tx.done;
  return existing !== undefined;
}

export async function countItems(filter: ItemFilter = {}): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('items', 'readonly');
  const keys = Object.keys(filter);
  const tags = normalizeTags(filter.tags ?? []);

  // Sciezki liczone wprost z indeksu - bez skanowania rekordow.
  if (keys.length === 0) return tx.store.count();
  if (keys.length === 1 && filter.archived !== undefined) {
    return tx.store.index('archived').count(filter.archived ? 1 : 0);
  }
  const onlyTag = tags[0];
  if (keys.length === 1 && tags.length === 1 && onlyTag !== undefined) {
    return tx.store.index('tags').count(onlyTag);
  }

  const allowedIds = await idsForTags(tx, tags);
  let count = 0;
  let cursor = await tx.store.openCursor();
  while (cursor !== null) {
    if (matchesFilter(cursor.value, filter, allowedIds)) count += 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

export interface SetContentInput {
  /** HTML juz przepuszczony przez DOMPurify. */
  html: string;
  text: string;
  contentHash?: string;
}

/**
 * Zapisuje tresc i w tej samej transakcji przestawia pozycje na `ready`
 * (oraz zapisuje `contentHash`, jesli podany). Dzieki temu nie ma stanu
 * posredniego, w ktorym tresc juz jest, a pozycja wciaz wisi jako `pending`.
 */
export async function setContent(itemId: string, input: SetContentInput): Promise<ItemContent> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents'], 'readwrite');
  const item = await tx.objectStore('items').get(itemId);
  if (item === undefined) {
    await tx.done;
    throw new Error(`Nie ma pozycji o id ${itemId} - nie zapisuje tresci.`);
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

/** Same klucze - do budowania indeksu wyszukiwania porcjami, bez wciagania tresci. */
export async function listContentIds(): Promise<string[]> {
  const db = await openDb();
  return db.getAllKeys('contents');
}

/** Porcja tresci. Wolane w petli po `listContentIds`, zeby nie trzymac
 *  jednej transakcji przez cala baze i nie blokowac UI. */
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
// highlights
// ---------------------------------------------------------------------------

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
    throw new Error(`Nie ma pozycji o id ${input.itemId} - nie zapisuje zaznaczenia.`);
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

/** Zaznaczenia jednej pozycji, w kolejnosci dodania. */
export async function listHighlights(itemId: string): Promise<Highlight[]> {
  const db = await openDb();
  const highlights = await db.getAllFromIndex('highlights', 'itemId', IDBKeyRange.only(itemId));
  return highlights.sort((a, b) => a.createdAt - b.createdAt);
}

/** Notatka przy zaznaczeniu. Rzuca, gdy zaznaczenia juz nie ma. */
export async function updateHighlight(
  id: string,
  patch: Partial<Pick<Highlight, 'note'>>,
): Promise<Highlight> {
  const db = await openDb();
  const tx = db.transaction('highlights', 'readwrite');
  const existing = await tx.store.get(id);
  if (existing === undefined) {
    await tx.done;
    throw new Error(`Nie ma zaznaczenia o id ${id}.`);
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

// ---------------------------------------------------------------------------
// Zrzut i scalanie (eksport / import / kopie)
// ---------------------------------------------------------------------------

/** Pelna zawartosc bazy bez snapshotow - to, co idzie do pliku kopii. */
export interface DatabaseDump {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
}

/** Co sie stalo przy scalaniu. Liczby ida wprost do raportu w opcjach. */
export interface MergeOutcome {
  /** Pozycje, ktorych wczesniej nie bylo. */
  added: number;
  /** Pozycje rozpoznane po znormalizowanym adresie i uzupelnione. */
  merged: number;
  contents: number;
  highlights: number;
  /** Rekordy pominiete juz na poziomie bazy (np. tresc bez pozycji). */
  skipped: number;
}

const EMPTY_OUTCOME: MergeOutcome = {
  added: 0,
  merged: 0,
  contents: 0,
  highlights: 0,
  skipped: 0,
};

/**
 * Caly zrzut w jednej transakcji tylko-do-odczytu, zeby eksport byl spojnym
 * obrazem bazy, a nie trzema odczytami z roznych chwil.
 */
export async function exportAll(): Promise<DatabaseDump> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readonly');
  const items = await tx.objectStore('items').getAll();
  const contents = await tx.objectStore('contents').getAll();
  const highlights = await tx.objectStore('highlights').getAll();
  await tx.done;

  items.sort((a, b) => b.savedAt - a.savedAt);
  return { items, contents, highlights };
}

/** Same metadane, najnowsze na gorze - do eksportu zakladek i do snapshotu. */
export async function listAllItems(): Promise<SavedItem[]> {
  const db = await openDb();
  const items = await db.getAll('items');
  return items.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Scala importowana pozycje z juz istniejaca.
 *
 * Zasada: stan uzytkownika po tej stronie jest wazniejszy niz plik. Import
 * moze DOLOZYC (tagi, brakujace metadane, wczesniejsza date zapisu, ulubione),
 * ale nie moze odebrac - nie odarchiwizuje, nie kasuje tagow, nie cofa
 * przeczytania. Inaczej przywrocenie starej kopii cofaloby biezaca prace.
 */
function mergeImported(existing: SavedItem, incoming: SavedItem): SavedItem {
  const wordCount = existing.wordCount === 0 ? incoming.wordCount : existing.wordCount;

  return withDerived({
    ...existing,
    title: existing.title === '' ? incoming.title : existing.title,
    excerpt: existing.excerpt === '' ? incoming.excerpt : existing.excerpt,
    byline: existing.byline ?? incoming.byline,
    siteName: existing.siteName ?? incoming.siteName,
    lang: existing.lang ?? incoming.lang,
    wordCount,
    estReadingMinutes:
      existing.estReadingMinutes === 0 ? incoming.estReadingMinutes : existing.estReadingMinutes,
    // Data zapisu to fakt historyczny - wygrywa wczesniejsza.
    savedAt: Math.min(existing.savedAt, incoming.savedAt),
    // Scalenie to zmiana lokalna - ma pojechac dalej przy nastepnym sync.
    updatedAt: Date.now(),
    readAt: existing.readAt ?? incoming.readAt,
    favorite: existing.favorite || incoming.favorite,
    tags: normalizeTags([...existing.tags, ...incoming.tags]),
    readingProgress: Math.max(existing.readingProgress, incoming.readingProgress),
  });
}

/** Dwa zaznaczenia o tym samym cytacie i offsetach to to samo zaznaczenie. */
function sameHighlight(a: Highlight, b: Highlight): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end;
}

/**
 * Wpisuje zrzut do bazy w JEDNEJ transakcji: albo wchodzi calosc, albo nic.
 * Blad w polowie (np. brak miejsca) cofa wszystko - nie zostawiamy polowy
 * importu ani tresci bez pozycji.
 *
 * Rekordy musza byc juz zwalidowane (patrz `src/lib/backup.ts`); tutaj
 * pilnujemy wylacznie spojnosci bazy: deduplikacji po adresie, kolizji
 * identyfikatorow i sierot w `contents`/`highlights`.
 */
export async function importDump(dump: DatabaseDump): Promise<MergeOutcome> {
  if (dump.items.length === 0 && dump.contents.length === 0 && dump.highlights.length === 0) {
    return { ...EMPTY_OUTCOME };
  }

  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights'], 'readwrite');

  try {
    const outcome = await writeDump(tx, dump);
    await tx.done;
    return outcome;
  } catch (error) {
    // Blad rzucony w trakcie (np. rekord nie do sklonowania) NIE przerywa sam
    // transakcji - bez tego `abort` IndexedDB domknelaby to, co juz weszlo,
    // i zostalaby polowa importu. Stad jawne wycofanie.
    try {
      tx.abort();
    } catch {
      // Transakcja mogla juz sama wyladowac w bledzie - wtedy nie ma czego cofac.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/** Wlasciwe scalanie. Wolane wylacznie z `importDump`, wewnatrz jego transakcji. */
async function writeDump(
  tx: IDBPTransaction<SavelyDB, ('items' | 'contents' | 'highlights')[], 'readwrite'>,
  dump: DatabaseDump,
): Promise<MergeOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const highlights = tx.objectStore('highlights');

  const outcome: MergeOutcome = { ...EMPTY_OUTCOME };
  /** id z pliku -> id w bazie; tym mapujemy tresci i zaznaczenia. */
  const target = new Map<string, string>();

  for (const incoming of dump.items) {
    const existing = await items.index('url').get(incoming.url);

    if (existing !== undefined) {
      await items.put(mergeImported(existing, incoming));
      target.set(incoming.id, existing.id);
      outcome.merged += 1;
      continue;
    }

    // Identyfikator z pliku moze juz nalezec do INNEJ pozycji - wtedy zapis
    // pod tym kluczem nadpisalby cudzy rekord. Bierzemy wtedy nowe id.
    const collision = await items.get(incoming.id);
    const id = collision === undefined ? incoming.id : crypto.randomUUID();

    await items.put(withDerived({ ...incoming, id }));
    target.set(incoming.id, id);
    outcome.added += 1;
  }

  for (const content of dump.contents) {
    const id = target.get(content.itemId);
    if (id === undefined) {
      outcome.skipped += 1;
      continue;
    }
    // Lokalna tresc jest swiezsza z definicji - importem jej nie nadpisujemy.
    if ((await contents.get(id)) !== undefined) {
      outcome.skipped += 1;
      continue;
    }
    await contents.put({ ...content, itemId: id });
    outcome.contents += 1;
  }

  for (const highlight of dump.highlights) {
    const id = target.get(highlight.itemId);
    if (id === undefined) {
      outcome.skipped += 1;
      continue;
    }

    const mine = await highlights.index('itemId').getAll(IDBKeyRange.only(id));
    if (mine.some((entry) => sameHighlight(entry, highlight))) {
      outcome.skipped += 1;
      continue;
    }

    const collision = await highlights.get(highlight.id);
    await highlights.put({
      ...highlight,
      id: collision === undefined ? highlight.id : crypto.randomUUID(),
      itemId: id,
    });
    outcome.highlights += 1;
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

/** Ile kopii trzymamy. Czwarta wypycha najstarsza. */
export const SNAPSHOT_LIMIT = 3;

/**
 * Odstep miedzy automatycznymi kopiami. Krocej niz doba, bo alarm potrafi
 * odpalic z poslizgiem, a przegapiony dzien boli bardziej niz kopia zrobiona
 * po dwudziestu godzinach.
 */
export const SNAPSHOT_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Kopia metadanych + przyciecie do `SNAPSHOT_LIMIT`, w jednej transakcji. */
export async function createSnapshot(now = Date.now()): Promise<Snapshot> {
  const db = await openDb();
  const tx = db.transaction(['items', 'snapshots'], 'readwrite');
  const items = await tx.objectStore('items').getAll();

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: now,
    itemCount: items.length,
    items,
  };

  const snapshots = tx.objectStore('snapshots');
  await snapshots.put(snapshot);

  // Klucze z indeksu `createdAt` ida od najstarszej - nadmiar scinamy z przodu.
  const byAge = await snapshots.index('createdAt').getAllKeys();
  for (const key of byAge.slice(0, Math.max(0, byAge.length - SNAPSHOT_LIMIT))) {
    await snapshots.delete(key);
  }

  await tx.done;
  return snapshot;
}

/**
 * Kopia dnia. `null`, gdy nie ma czego kopiowac albo ostatnia jest swieza -
 * alarm potrafi odpalic czesciej niz raz na dobe (wybudzenie, reinstalacja).
 */
export async function createSnapshotIfDue(now = Date.now()): Promise<Snapshot | null> {
  const db = await openDb();
  if ((await db.count('items')) === 0) return null;

  const [fresh] = await db.getAllFromIndex(
    'snapshots',
    'createdAt',
    IDBKeyRange.lowerBound(now - SNAPSHOT_INTERVAL_MS),
    1,
  );
  if (fresh !== undefined) return null;

  return createSnapshot(now);
}

/** Podsumowania kopii, najnowsze na gorze. Bez `items` - patrz `SnapshotSummary`. */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const db = await openDb();
  const snapshots = await db.getAll('snapshots');
  return snapshots
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, createdAt, itemCount }) => ({ id, createdAt, itemCount }));
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const db = await openDb();
  return db.get('snapshots', id);
}

/**
 * Przywraca kopie przez to samo scalanie, co import: doklada brakujace
 * pozycje i uzupelnia istniejace, ale niczego nie kasuje. Przywrocenie kopii
 * nie moze zabrac tego, co doszlo po jej zrobieniu.
 */
export async function restoreSnapshot(id: string): Promise<MergeOutcome> {
  const snapshot = await getSnapshot(id);
  if (snapshot === undefined) throw new Error(`Nie ma kopii o id ${id}.`);
  return importDump({ items: snapshot.items, contents: [], highlights: [] });
}

// ---------------------------------------------------------------------------
// Statystyki i kasowanie
// ---------------------------------------------------------------------------

export interface DataStats {
  items: number;
  unread: number;
  archived: number;
  favorite: number;
  contents: number;
  highlights: number;
  snapshots: number;
}

/** Liczniki na strone opcji. Jeden przebieg po `items`, reszta z `count()`. */
export async function dataStats(): Promise<DataStats> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'snapshots'], 'readonly');

  const stats: DataStats = {
    items: 0,
    unread: 0,
    archived: 0,
    favorite: 0,
    contents: await tx.objectStore('contents').count(),
    highlights: await tx.objectStore('highlights').count(),
    snapshots: await tx.objectStore('snapshots').count(),
  };

  let cursor = await tx.objectStore('items').openCursor();
  while (cursor !== null) {
    const item = cursor.value;
    stats.items += 1;
    if (item.readAt === null) stats.unread += 1;
    if (item.archived) stats.archived += 1;
    if (item.favorite) stats.favorite += 1;
    cursor = await cursor.continue();
  }

  await tx.done;
  return stats;
}

/**
 * "Usun wszystkie dane" - kasujemy cala baze zamiast czyscic magazyny po
 * kolei. Przy okazji znika wszystko, o czym ten kod moglby zapomniec.
 */
export async function clearAllData(): Promise<void> {
  await deleteDb();
}

// ---------------------------------------------------------------------------
// Synchronizacja: odczyt stanu i zapis wyniku scalenia
// ---------------------------------------------------------------------------

/**
 * Stan lokalny w postaci, w ktorej porownuje sie go ze zdalnym.
 *
 * Kluczem jest **znormalizowany adres**, nie `id`: identyfikatory sa lokalne
 * dla urzadzenia i po dwoch stronach synchronizacji nigdy nie beda te same.
 */
export interface SyncLocalState {
  items: SavedItem[];
  contents: ItemContent[];
  highlights: Highlight[];
  tombstones: Tombstone[];
}

/** Jedna pozycja do zapisania po scaleniu. `null` = ta czesc bez zmian. */
export interface SyncItemWrite {
  /** `id` i `archivedKey` ustala baza - reszta przychodzi ze scalenia. */
  item: Omit<SavedItem, 'id' | 'archivedKey'>;
  content: { html: string; text: string; updatedAt: number } | null;
  /** Pelny, scalony zbior zaznaczen tej pozycji. */
  highlights: Omit<Highlight, 'id' | 'itemId'>[] | null;
}

export interface SyncWritePlan {
  writes: SyncItemWrite[];
  /** Adresy pozycji, ktore zniknely po drugiej stronie (grob jest nowszy). */
  deleteUrls: string[];
  tombstones: Tombstone[];
}

export interface SyncWriteOutcome {
  added: number;
  updated: number;
  deleted: number;
  contents: number;
  highlights: number;
}

/** Caly stan potrzebny do scalenia, w jednej transakcji tylko-do-odczytu. */
export async function collectForSync(): Promise<SyncLocalState> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readonly');
  const state: SyncLocalState = {
    items: await tx.objectStore('items').getAll(),
    contents: await tx.objectStore('contents').getAll(),
    highlights: await tx.objectStore('highlights').getAll(),
    tombstones: await tx.objectStore('tombstones').getAll(),
  };
  await tx.done;
  return state;
}

export async function listTombstones(): Promise<Tombstone[]> {
  const db = await openDb();
  return db.getAll('tombstones');
}

/**
 * Zapisuje wynik scalenia. Jedna transakcja na cztery magazyny: przerwanie
 * w polowie cofa calosc, wiec nie zostaje baza w stanie "pol zsynchronizowana"
 * (ta sama zasada, co przy imporcie).
 *
 * Scalanie jest w `src/lib/sync/merge.ts` - tutaj wylacznie zapis tego, co tamto
 * postanowilo, plus mapowanie adres -> lokalne `id`.
 */
export async function applySync(plan: SyncWritePlan): Promise<SyncWriteOutcome> {
  const db = await openDb();
  const tx = db.transaction(['items', 'contents', 'highlights', 'tombstones'], 'readwrite');

  try {
    const outcome = await writeSync(tx, plan);
    await tx.done;
    return outcome;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Transakcja mogla juz sama wyladowac w bledzie.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

async function writeSync(
  tx: IDBPTransaction<
    SavelyDB,
    ('items' | 'contents' | 'highlights' | 'tombstones')[],
    'readwrite'
  >,
  plan: SyncWritePlan,
): Promise<SyncWriteOutcome> {
  const items = tx.objectStore('items');
  const contents = tx.objectStore('contents');
  const highlights = tx.objectStore('highlights');
  const tombstones = tx.objectStore('tombstones');

  const outcome: SyncWriteOutcome = {
    added: 0,
    updated: 0,
    deleted: 0,
    contents: 0,
    highlights: 0,
  };

  for (const write of plan.writes) {
    const existing = await items.index('url').get(write.item.url);
    const id = existing?.id ?? crypto.randomUUID();

    await items.put(withDerived({ ...write.item, id }));
    if (existing === undefined) outcome.added += 1;
    else outcome.updated += 1;

    if (write.content !== null) {
      await contents.put({ itemId: id, ...write.content });
      outcome.contents += 1;
    }

    if (write.highlights !== null) {
      // Scalony zbior wchodzi w calosci: `merge` oddaje go tylko wtedy, gdy
      // rozni sie od lokalnego, wiec nie ma tu ruchu bez powodu.
      let cursor = await highlights.index('itemId').openCursor(IDBKeyRange.only(id));
      while (cursor !== null) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      for (const highlight of write.highlights) {
        await highlights.put({ ...highlight, id: crypto.randomUUID(), itemId: id });
        outcome.highlights += 1;
      }
    }
  }

  for (const url of plan.deleteUrls) {
    const existing = await items.index('url').get(url);
    if (existing === undefined) continue;

    await items.delete(existing.id);
    await contents.delete(existing.id);
    let cursor = await highlights.index('itemId').openCursor(IDBKeyRange.only(existing.id));
    while (cursor !== null) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    outcome.deleted += 1;
  }

  for (const tombstone of plan.tombstones) {
    const known = await tombstones.get(tombstone.url);
    if (known === undefined || known.deletedAt < tombstone.deletedAt) {
      await tombstones.put(tombstone);
    }
  }

  return outcome;
}
