// @vitest-environment jsdom
/**
 * The card is the same element in both modes; what differs is how much of it
 * fits. In the popup a row is 84 px and the tags share their line with the
 * actions, so the card shows one tag and counts the rest - the count is the
 * part that must stay honest.
 */
import { describe, expect, it } from 'vitest';

import type { SavedItem } from '@/lib/db';

import { CARD_LAYOUT, createCard } from './cards';

const CALLBACKS = {
  openReader: () => undefined,
  openOriginal: () => undefined,
  toggleArchive: () => undefined,
  toggleFavorite: () => undefined,
  editTags: () => undefined,
  remove: () => undefined,
  filterByTag: () => undefined,
};

function item(tags: string[]): SavedItem {
  return {
    id: 'i1',
    url: 'https://example.com/a',
    resolvedUrl: 'https://example.com/a',
    title: 'A centre without cars',
    excerpt: '',
    byline: null,
    siteName: null,
    lang: null,
    wordCount: 400,
    estReadingMinutes: 2,
    savedAt: Date.now(),
    updatedAt: Date.now(),
    readAt: null,
    archived: false,
    favorite: false,
    tags,
    contentHash: null,
    status: 'ready',
    readingProgress: 0,
    archivedKey: 0,
  };
}

function chips(card: HTMLLIElement): (string | null)[] {
  return [...card.querySelectorAll('.card__tags .chip')].map((chip) => chip.textContent);
}

function meta(card: HTMLLIElement): string {
  return card.querySelector('.card__meta')?.textContent ?? '';
}

describe('the metadata line', () => {
  it('carries the reading time and the save date on the full page', () => {
    // `savedAt` is today's date, so the wording is relative, not a date.
    expect(meta(createCard(item([]), 0, CALLBACKS, CARD_LAYOUT.full))).toBe(
      'example.com · 2 min · today',
    );
  });

  it('is the site alone in the popup, where it shares the line with the actions', () => {
    expect(meta(createCard(item([]), 0, CALLBACKS, CARD_LAYOUT.popup))).toBe('example.com');
  });

  it('still says when an item has no content to read - in either mode', () => {
    const failed = { ...item([]), status: 'failed' as const };
    expect(meta(createCard(failed, 0, CALLBACKS, CARD_LAYOUT.popup))).toContain('no content');
    expect(meta(createCard(failed, 0, CALLBACKS, CARD_LAYOUT.full))).toContain('no content');
  });
});

describe('the tags on a card', () => {
  it('shows three on the full page and counts the rest', () => {
    const card = createCard(item(['rust', 'cities', 'transit', 'maps']), 0, CALLBACKS, CARD_LAYOUT.full);
    expect(chips(card)).toEqual(['#rust', '#cities', '#transit', '+1']);
  });

  it('shows one in the popup, where it shares the line with the actions', () => {
    const card = createCard(item(['rust', 'cities', 'transit']), 0, CALLBACKS, CARD_LAYOUT.popup);
    expect(chips(card)).toEqual(['#rust', '+2']);
  });

  it('adds no counter when everything fits', () => {
    expect(chips(createCard(item(['rust']), 0, CALLBACKS, CARD_LAYOUT.popup))).toEqual(['#rust']);
    expect(chips(createCard(item([]), 0, CALLBACKS, CARD_LAYOUT.popup))).toEqual([]);
  });

  it('the actions are all there either way - the popup drops none of them', () => {
    const popup = createCard(item(['rust', 'cities']), 0, CALLBACKS, CARD_LAYOUT.popup);
    expect(popup.querySelectorAll('.card__actions .icon')).toHaveLength(6);
  });
});
