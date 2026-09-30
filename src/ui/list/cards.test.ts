// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { SavedItem } from '@/types/item';

import { CARD_LAYOUT, createCard } from './cards';

const CALLBACKS = {
  openOriginal: () => undefined,
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
    expect(meta(createCard(item([]), 0, CALLBACKS, CARD_LAYOUT.full))).toBe(
      'example.com · 2 min · today',
    );
  });

  it('is the site alone in the popup, where it shares the line with the tags', () => {
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

  it('shows one in the popup, where it shares the line with the metadata', () => {
    const card = createCard(item(['rust', 'cities', 'transit']), 0, CALLBACKS, CARD_LAYOUT.popup);
    expect(chips(card)).toEqual(['#rust', '+2']);
  });

  it('adds no counter when everything fits', () => {
    expect(chips(createCard(item(['rust']), 0, CALLBACKS, CARD_LAYOUT.popup))).toEqual(['#rust']);
    expect(chips(createCard(item([]), 0, CALLBACKS, CARD_LAYOUT.popup))).toEqual([]);
  });

});

describe('pressing a card', () => {
  it('carries no action buttons - those live in the toolbar', () => {
    const card = createCard(item(['rust']), 0, CALLBACKS, CARD_LAYOUT.full);
    expect([...card.querySelectorAll('button')].map((node) => node.className)).toEqual(['chip']);
  });

  it('a double click opens the original', () => {
    const openOriginal = vi.fn();
    const card = createCard(item([]), 0, { ...CALLBACKS, openOriginal }, CARD_LAYOUT.full);

    card.querySelector('.card__title')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(openOriginal).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }));
  });

  it('a double click on a tag chip filters, and opens nothing', () => {
    const openOriginal = vi.fn();
    const filterByTag = vi.fn();
    const card = createCard(item(['rust']), 0, { openOriginal, filterByTag }, CARD_LAYOUT.full);

    const chip = card.querySelector('.chip');
    chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    chip?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(filterByTag).toHaveBeenCalledWith('rust');
    expect(openOriginal).not.toHaveBeenCalled();
  });
});
