/**
 * Merge tests. A pure function, so every case is one local state plus one
 * remote state - no database, no network, no clock.
 *
 * What interests us is not so much "does it merge" as **does nothing get
 * lost**: tags and highlights added independently on two devices, a deliberate
 * deletion, and a deliberate edit after a deletion.
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
    title: 'A title',
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
    title: 'A title',
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
  return { items: [], contents: [], highlights: [], tombstones: [], base: [], ...state };
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

describe('the first run', () => {
  it('with no remote data it pushes everything and changes nothing locally', () => {
    const result = merge(local({ items: [localItem({ url: URL_A, tags: ['rust'] })] }), null);

    expect(result.payload.items).toHaveLength(1);
    expect(result.payload.items[0]?.tags).toEqual(['rust']);
    expect(result.plan.writes).toEqual([]);
    expect(result.plan.deleteUrls).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it('an empty database takes everything from the other side', () => {
    const result = merge(
      local(),
      remote({
        items: [remoteItem({ url: URL_A, title: 'From the remote' })],
        contents: { [URL_A]: { html: '<p>a</p>', text: 'a', updatedAt: 900 } },
      }),
    );

    expect(result.plan.writes).toHaveLength(1);
    expect(result.plan.writes[0]?.item.title).toBe('From the remote');
    expect(result.plan.writes[0]?.content?.html).toBe('<p>a</p>');
  });
});

describe('last-write-wins by updatedAt', () => {
  it('a newer remote side overwrites the local fields', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, title: 'Old', updatedAt: 1_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, title: 'New', updatedAt: 2_000, favorite: true })] }),
    );

    expect(result.plan.writes[0]?.item.title).toBe('New');
    expect(result.plan.writes[0]?.item.favorite).toBe(true);
    expect(result.conflicts).toBe(1);
  });

  it('a newer local side stays and travels on', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, title: 'Local', updatedAt: 3_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, title: 'Remote', updatedAt: 2_000 })] }),
    );

    expect(result.plan.writes).toEqual([]);
    expect(result.payload.items[0]?.title).toBe('Local');
  });

  it('identical records are neither a conflict nor a write', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })] }),
      remote({ items: [remoteItem({ url: URL_A })] }),
    );

    expect(result.conflicts).toBe(0);
    expect(result.plan.writes).toEqual([]);
  });
});

describe('the union of tags and highlights', () => {
  it('tags from both sides add up, even when one side won the item', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['local'], updatedAt: 1_000 })] }),
      remote({ items: [remoteItem({ url: URL_A, tags: ['remote'], updatedAt: 5_000 })] }),
    );

    expect(result.payload.items[0]?.tags).toEqual(['local', 'remote']);
    expect(result.plan.writes[0]?.item.tags).toEqual(['local', 'remote']);
  });

  it('highlights from both sides add up', () => {
    const highlight: Highlight = {
      id: 'h1',
      itemId: `local-${URL_A}`,
      text: 'local quote',
      note: null,
      createdAt: 1_000,
      start: 0,
      end: 11,
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
                text: 'remote quote',
                note: 'a note',
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
    expect(merged.map((entry) => entry.text).sort()).toEqual(['local quote', 'remote quote']);
    expect(result.plan.writes[0]?.highlights).toHaveLength(2);
  });

  it('the same quote with a note on one side keeps the note', () => {
    const highlight: Highlight = {
      id: 'h1',
      itemId: `local-${URL_A}`,
      text: 'a quote',
      note: null,
      createdAt: 1_000,
      start: 0,
      end: 7,
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
              { text: 'a quote', note: 'important', createdAt: 1_000, start: 0, end: 7, prefix: '', suffix: '' },
            ],
          }),
        ],
      }),
    );

    expect(result.payload.items[0]?.highlights).toEqual([
      { text: 'a quote', note: 'important', createdAt: 1_000, start: 0, end: 7, prefix: '', suffix: '' },
    ]);
  });
});

describe('content', () => {
  it('follows its own updatedAt, independently of the item', () => {
    const content: ItemContent = {
      itemId: `local-${URL_A}`,
      html: '<p>local</p>',
      text: 'local',
      updatedAt: 5_000,
    };

    const result = merge(
      local({ items: [localItem({ url: URL_A, updatedAt: 1_000 })], contents: [content] }),
      remote({
        items: [remoteItem({ url: URL_A, updatedAt: 9_000 })],
        contents: { [URL_A]: { html: '<p>remote</p>', text: 'remote', updatedAt: 2_000 } },
      }),
    );

    // The remote side won the item, but the local content is fresher.
    expect(result.payload.contents[URL_A]?.html).toBe('<p>local</p>');
    expect(result.plan.writes[0]?.content).toBeNull();
  });

  it('no local content means pulling the remote one', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })] }),
      remote({
        items: [remoteItem({ url: URL_A })],
        contents: { [URL_A]: { html: '<p>remote</p>', text: 'remote', updatedAt: 2_000 } },
      }),
    );

    expect(result.plan.writes[0]?.content?.html).toBe('<p>remote</p>');
  });
});

describe('deletion', () => {
  it('a remote tombstone newer than the change deletes the item locally', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, updatedAt: 1_000 })] }),
      remote({ tombstones: [{ url: URL_A, deletedAt: 2_000 }] }),
    );

    expect(result.plan.deleteUrls).toEqual([URL_A]);
    expect(result.payload.items).toEqual([]);
    expect(result.payload.tombstones).toEqual([{ url: URL_A, deletedAt: 2_000 }]);
  });

  it('a local tombstone stops the item coming back from the other side', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 5_000 }] }),
      remote({ items: [remoteItem({ url: URL_A, updatedAt: 1_000 })] }),
    );

    expect(result.plan.writes).toEqual([]);
    expect(result.payload.items).toEqual([]);
  });

  it('a change younger than the tombstone resurrects the item', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 2_000 }] }),
      remote({ items: [remoteItem({ url: URL_A, updatedAt: 9_000, title: 'It came back' })] }),
    );

    expect(result.plan.writes[0]?.item.title).toBe('It came back');
    expect(result.payload.items).toHaveLength(1);
  });

  it('tombstones from both sides merge on the later date', () => {
    const result = merge(
      local({ tombstones: [{ url: URL_A, deletedAt: 1_000 }] }),
      remote({ tombstones: [{ url: URL_A, deletedAt: 7_000 }] }),
    );

    expect(result.payload.tombstones).toEqual([{ url: URL_A, deletedAt: 7_000 }]);
    expect(result.plan.tombstones).toEqual([{ url: URL_A, deletedAt: 7_000 }]);
  });
});

describe('identity by address', () => {
  it('the same article with tracking parameters is one item', () => {
    const result = merge(
      local({ items: [localItem({ url: 'https://a.example/1', tags: ['local'] })] }),
      remote({ items: [remoteItem({ url: 'https://a.example/1', tags: ['remote'] })] }),
    );

    expect(result.payload.items).toHaveLength(1);
    expect(result.payload.items[0]?.tags).toEqual(['local', 'remote']);
  });
});

describe('removals, measured against the base', () => {
  const QUOTE = { text: 'a quote', createdAt: 1_000, start: 0, end: 7, prefix: '', suffix: '' };

  function localHighlight(note: string | null): Highlight {
    return { ...QUOTE, id: 'h1', itemId: `local-${URL_A}`, note };
  }

  function base(
    tags: string[],
    highlights: { text: string; note: string | null; start: number; end: number }[] = [],
  ): SyncLocalState['base'] {
    return [{ url: URL_A, tags, highlights }];
  }

  it('a tag removed here stays removed, however much the other side still has it', () => {
    const result = merge(
      local({
        items: [localItem({ url: URL_A, tags: [], updatedAt: 2_000 })],
        base: base(['rust']),
      }),
      remote({ items: [remoteItem({ url: URL_A, tags: ['rust'], updatedAt: 1_000 })] }),
    );

    expect(result.payload.items[0]?.tags).toEqual([]);
  });

  it('a tag removed on the other side is removed here', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['rust'] })], base: base(['rust']) }),
      remote({ items: [remoteItem({ url: URL_A, tags: [], updatedAt: 2_000 })] }),
    );

    expect(result.plan.writes[0]?.item.tags).toEqual([]);
  });

  it('a tag added on either side since the base is kept', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['mine', 'rust'] })], base: base(['rust']) }),
      remote({ items: [remoteItem({ url: URL_A, tags: ['rust', 'theirs'], updatedAt: 2_000 })] }),
    );

    expect(result.payload.items[0]?.tags).toEqual(['mine', 'rust', 'theirs']);
  });

  it('a highlight deleted on the other side is deleted here', () => {
    const result = merge(
      local({
        items: [localItem({ url: URL_A })],
        highlights: [localHighlight(null)],
        base: base([], [{ ...QUOTE, note: null }]),
      }),
      remote({ items: [remoteItem({ url: URL_A, highlights: [] })] }),
    );

    expect(result.plan.writes[0]?.highlights).toEqual([]);
    expect(result.payload.items[0]?.highlights).toEqual([]);
  });

  it('a highlight deleted here does not come back from the other side', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })], base: base([], [{ ...QUOTE, note: null }]) }),
      remote({ items: [remoteItem({ url: URL_A, highlights: [{ ...QUOTE, note: null }] })] }),
    );

    expect(result.payload.items[0]?.highlights).toEqual([]);
    expect(result.plan.writes).toEqual([]);
  });

  it('a note edited on one side survives the highlight being deleted on the other', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A })], base: base([], [{ ...QUOTE, note: 'old' }]) }),
      remote({ items: [remoteItem({ url: URL_A, highlights: [{ ...QUOTE, note: 'new' }] })] }),
    );

    expect(result.payload.items[0]?.highlights.map((entry) => entry.note)).toEqual(['new']);
  });

  it('a note cleared here stays cleared', () => {
    const result = merge(
      local({
        items: [localItem({ url: URL_A })],
        highlights: [localHighlight(null)],
        base: base([], [{ ...QUOTE, note: 'a note' }]),
      }),
      remote({ items: [remoteItem({ url: URL_A, highlights: [{ ...QUOTE, note: 'a note' }] })] }),
    );

    expect(result.payload.items[0]?.highlights.map((entry) => entry.note)).toEqual([null]);
  });

  it('a note changed on the other side arrives here', () => {
    const result = merge(
      local({
        items: [localItem({ url: URL_A })],
        highlights: [localHighlight('a note')],
        base: base([], [{ ...QUOTE, note: 'a note' }]),
      }),
      remote({ items: [remoteItem({ url: URL_A, highlights: [{ ...QUOTE, note: 'rewritten' }] })] }),
    );

    expect(result.plan.writes[0]?.highlights?.map((entry) => entry.note)).toEqual(['rewritten']);
  });

  it('with nothing on the other side the base means nothing', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['rust'] })], base: base(['rust', 'gone']) }),
      null,
    );

    expect(result.payload.items[0]?.tags).toEqual(['rust']);
  });

  it('hands back the base for the next merge - what is being pushed', () => {
    const result = merge(
      local({ items: [localItem({ url: URL_A, tags: ['rust'] })], highlights: [localHighlight('n')] }),
      null,
    );

    expect(result.base).toEqual([
      { url: URL_A, tags: ['rust'], highlights: [{ text: 'a quote', note: 'n', start: 0, end: 7 }] },
    ]);
  });
});
