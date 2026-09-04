/**
 * Testy scalania. Czysta funkcja, więc każdy przypadek to jeden stan lokalny
 * plus jeden zdalny - bez bazy, bez sieci, bez zegara.
 *
 * Interesuje nas nie tyle „czy się scala", co **czy nic nie ginie**: tagi
 * i podświetlenia dopisane niezależnie na dwóch urządzeniach, świadome
 * kasowanie i świadoma edycja po kasowaniu.
 */
import { describe, expect, it } from 'vitest';

import type { Highlight, ItemContent, SavedItem, SyncLocalState } from '../db';

import { mergeStates } from './merge';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION, type SyncItem, type SyncPayload } from './types';

const NOW = 10_000;

function localItem(overrides: Partial<SavedItem> & Pick<SavedItem, 'url'>): SavedItem {
  return {
    id: `local-${overrides.url}`,
    resolvedUrl: overrides.url,
    title: 'Tytuł',
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

function remoteItem(overrides: Partial<SyncItem> & Pick<SyncItem, 'url'>): SyncItem {
  return {
    resolvedUrl: overrides.url,
    title: 'Tytuł',
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
    highlights: [],
    ...overrides,
  };
}

function local(state: Partial<SyncLocalState> = {}): SyncLocalState {
  return { items: [], contents: [], highlights: [], tombstones: [], ...state };
}

function remote(payload: Partial<SyncPayload> = {}): SyncPayload {
  return {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    schemaVersion: 4,
    updatedAt: 5_000,
    items: [],
    tombstones: [],
    contents: {},
    ...payload,
  };
}

function merge(localState: SyncLocalState, remoteState: SyncPayload | null) {
  return mergeStates({ local: localState, remote: remoteState, schemaVersion: 4, now: NOW });
}

const URL_A = 'https://a.example/1';

describe('pierwsze uruchomienie', () => {
  it('bez danych zdalnych wysyła wszystko i nie zmienia niczego lokalnie', () => {
    const result = merge(local({ items: [localItem({ url: URL_A, tags: ['rust'] })] }), null);

    expect(result.payload.items).toHaveLength(1);
    expect(result.payload.items[0]?.tags).toEqual(['rust']);
    expect(result.plan.writes).toEqual([]);
    expect(result.plan.deleteUrls).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it('pusta baza przyjmuje wszystko z drugiej strony', () => {
    const result = merge(
      local(),
      remote({
        items: [remoteItem({ url: URL_A, title: 'Ze zdalnego' })],
        contents: { [URL_A]: { html: '<p>a</p>', text: 'a', updatedAt: 900 } },
      }),
    );

    expect(result.plan.writes).toHaveLength(1);
    expect(result.plan.writes[0]?.item.title).toBe('Ze zdalnego');
    expect(result.plan.writes[0]?.content?.html).toBe('<p>a</p>');
  });
});

describe('last-write-wins po updatedAt', () => {
  it('nowsza strona zdalna nadpisuje pola lokalne', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, title: 'Stary', updatedAt: 1_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, title: 'Nowy', updatedAt: 2_000, favorite: true })] }),
    );

    expect(result.plan.writes[0]?.item.title).toBe('Nowy');
    expect(result.plan.writes[0]?.item.favorite).toBe(true);
    expect(result.conflicts).toBe(1);
  });

  it('nowsza strona lokalna zostaje i idzie dalej', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, title: 'Lokalny', updatedAt: 3_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, title: 'Zdalny', updatedAt: 2_000 })] }),
    );

    expect(result.plan.writes).toEqual([]);
    expect(result.payload.items[0]?.title).toBe('Lokalny');
  });

  it('identyczne rekordy to nie konflikt i nie zapis', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })] }),
      remote({ items: [remoteItem({ url: URL_A })] }),
    );

    expect(result.conflicts).toBe(0);
    expect(result.plan.writes).toEqual([]);
  });
});

describe('suma tagów i podświetleń', () => {
  it('tagi z obu stron się dodają, nawet gdy pozycję wygrała jedna', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['lokalny'], updatedAt: 1_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, tags: ['zdalny'], updatedAt: 5_000 })] }),
    );

    expect(result.payload.items[0]?.tags).toEqual(['lokalny', 'zdalny']);
    expect(result.plan.writes[0]?.item.tags).toEqual(['lokalny', 'zdalny']);
  });

  it('podświetlenia z obu stron się dodają', () => {
    const highlight: Highlight = {
      id: 'h1',
      itemId: `local-${URL_A}`,
      text: 'lokalny cytat',
      note: null,
      createdAt: 1_000,
      start: 0,
      end: 13,
      prefix: '',
      suffix: '',
    };

    const result = merge(
      local({ items: [localItem({ url: URL_A })], highlights: [highlight] }),
      remote({
        items: [
          remoteItem({
            url: URL_A,
            highlights: [
              {
                text: 'zdalny cytat',
                note: 'notatka',
                createdAt: 2_000,
                start: 20,
                end: 32,
                prefix: '',
                suffix: '',
              },
            ],
          }),
        ],
      }),
    );

    const merged = result.payload.items[0]?.highlights ?? [];
    expect(merged.map((entry) => entry.text).sort()).toEqual(['lokalny cytat', 'zdalny cytat']);
    expect(result.plan.writes[0]?.highlights).toHaveLength(2);
  });

  it('ten sam cytat z notatką po jednej stronie zachowuje notatkę', () => {
    const highlight: Highlight = {
      id: 'h1',
      itemId: `local-${URL_A}`,
      text: 'cytat',
      note: null,
      createdAt: 1_000,
      start: 0,
      end: 5,
      prefix: '',
      suffix: '',
    };

    const result = merge(
      local({ items: [localItem({ url: URL_A })], highlights: [highlight] }),
      remote({
        items: [
          remoteItem({
            url: URL_A,
            highlights: [
              { text: 'cytat', note: 'ważne', createdAt: 1_000, start: 0, end: 5, prefix: '', suffix: '' },
            ],
          }),
        ],
      }),
    );

    expect(result.payload.items[0]?.highlights).toEqual([
      { text: 'cytat', note: 'ważne', createdAt: 1_000, start: 0, end: 5, prefix: '', suffix: '' },
    ]);
  });
});

describe('treść', () => {
  it('idzie za własnym updatedAt, niezależnie od pozycji', () => {
    const content: ItemContent = {
      itemId: `local-${URL_A}`,
      html: '<p>lokalna</p>',
      text: 'lokalna',
      updatedAt: 5_000,
    };

    const result = merge(
      local({ items: [localItem({ url: URL_A, updatedAt: 1_000 })], contents: [content] }),
      remote({
        items: [remoteItem({ url: URL_A, updatedAt: 9_000 })],
        contents: { [URL_A]: { html: '<p>zdalna</p>', text: 'zdalna', updatedAt: 2_000 } },
      }),
    );

    // Pozycję wygrała strona zdalna, ale treść lokalna jest świeższa.
    expect(result.payload.contents[URL_A]?.html).toBe('<p>lokalna</p>');
    expect(result.plan.writes[0]?.content).toBeNull();
  });

  it('brak treści lokalnie oznacza pobranie zdalnej', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })] }),
      remote({
        items: [remoteItem({ url: URL_A })],
        contents: { [URL_A]: { html: '<p>zdalna</p>', text: 'zdalna', updatedAt: 2_000 } },
      }),
    );

    expect(result.plan.writes[0]?.content?.html).toBe('<p>zdalna</p>');
  });
});

describe('kasowanie', () => {
  it('grób zdalny nowszy niż zmiana kasuje pozycję lokalnie', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, updatedAt: 1_000 })] }),
      remote({ tombstones: [{ url: URL_A, deletedAt: 2_000 }] }),
    );

    expect(result.plan.deleteUrls).toEqual([URL_A]);
    expect(result.payload.items).toEqual([]);
    expect(result.payload.tombstones).toEqual([{ url: URL_A, deletedAt: 2_000 }]);
  });

  it('grób lokalny nie pozwala pozycji wrócić z drugiej strony', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 5_000 }] }),
      remote({ items: [remoteItem({ url: URL_A, updatedAt: 1_000 })] }),
    );

    expect(result.plan.writes).toEqual([]);
    expect(result.payload.items).toEqual([]);
  });

  it('zmiana młodsza niż grób wskrzesza pozycję', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 2_000 }] }),
      remote({ items: [remoteItem({ url: URL_A, updatedAt: 9_000, title: 'Wróciła' })] }),
    );

    expect(result.plan.writes[0]?.item.title).toBe('Wróciła');
    expect(result.payload.items).toHaveLength(1);
  });

  it('groby z obu stron scalają się po późniejszej dacie', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 1_000 }] }),
      remote({ tombstones: [{ url: URL_A, deletedAt: 7_000 }] }),
    );

    expect(result.payload.tombstones).toEqual([{ url: URL_A, deletedAt: 7_000 }]);
    expect(result.plan.tombstones).toEqual([{ url: URL_A, deletedAt: 7_000 }]);
  });
});

describe('tożsamość po adresie', () => {
  it('ten sam artykuł z parametrami śledzącymi to jedna pozycja', () => {
    const result = merge(
      local({ items: [localItem({ url: 'https://a.example/1', tags: ['lokalny'] })] }),
      remote({ items: [remoteItem({ url: 'https://a.example/1', tags: ['zdalny'] })] }),
    );

    expect(result.payload.items).toHaveLength(1);
    expect(result.payload.items[0]?.tags).toEqual(['lokalny', 'zdalny']);
  });
});
