/**
 * Building an item card.
 *
 * A card carries no buttons of its own. A click selects it and the toolbar in
 * the top bar acts on the selection (`list.ts`), and a double click opens the
 * original page. Six buttons on every card were six targets per row, most of
 * them the size of a fingertip, and they took the room the title needed.
 *
 * The whole UI is assembled with `createElement` + `textContent` - no
 * `innerHTML` with user data or page data (CLAUDE.md 3).
 */
import type { SavedItem } from '@/lib/library';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from '@/ui/shared/format';
import { moreChip, tagChip } from './chips';

export interface CardCallbacks {
  openOriginal: (item: SavedItem) => void;
  filterByTag: (tag: string) => void;
}

/**
 * What fits on a card. The same element serves both modes; the popup's row is
 * 64 px and one line wide, so it carries less of the same information - never
 * different information.
 */
export interface CardLayout {
  /** How many tags are shown before the rest become a "+n". */
  tagLimit: number;
  /** Whether the metadata line has room for the save date. */
  savedAt: boolean;
  /** Whether it has room for the reading time. */
  readingTime: boolean;
}

export const CARD_LAYOUT: Record<'full' | 'popup', CardLayout> = {
  full: { tagLimit: 3, savedAt: true, readingTime: true },
  // In the popup the metadata shares its line with the tags, so it is down
  // to what identifies the item: the site it came from - and, when there is
  // something wrong with the item, what.
  popup: { tagLimit: 1, savedAt: false, readingTime: false },
};

export function createCard(
  item: SavedItem,
  index: number,
  callbacks: CardCallbacks,
  layout: CardLayout = CARD_LAYOUT.full,
): HTMLLIElement {
  const card = document.createElement('li');
  card.className = 'card';
  card.dataset['id'] = item.id;
  card.dataset['index'] = String(index);
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', 'false');
  card.tabIndex = -1;

  // The site icon, filled in by the list from the `favicons` store - the card
  // itself knows nothing about where icons come from. Decorative: the domain is
  // written out right below it, so a screen reader gains nothing from the image.
  const thumb = document.createElement('img');
  thumb.className = 'card__thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.hidden = true;
  card.append(thumb);

  const body = document.createElement('div');
  body.className = 'card__body';

  const title = document.createElement('p');
  title.className = 'card__title';
  title.textContent = item.title === '' ? formatDomain(item.url) : item.title;
  body.append(title);

  const meta = document.createElement('p');
  meta.className = 'card__meta';
  const parts = [
    formatDomain(item.url),
    layout.readingTime ? formatReadingTime(item.estReadingMinutes) : '',
    layout.savedAt ? formatSavedAt(item.savedAt) : '',
    formatStatus(item.status),
  ].filter((part) => part !== '');
  meta.textContent = parts.join(' · ');
  body.append(meta);

  const footer = document.createElement('div');
  footer.className = 'card__footer';

  const tags = document.createElement('div');
  tags.className = 'card__tags';
  for (const tag of item.tags.slice(0, layout.tagLimit)) {
    tags.append(
      tagChip(tag, {
        title: `Filter by #${tag}`,
        onClick: (event) => {
          // A click on the card selects it; a chip narrows the list instead.
          event.stopPropagation();
          callbacks.filterByTag(tag);
        },
      }),
    );
  }
  if (item.tags.length > layout.tagLimit) {
    tags.append(moreChip(item.tags.length - layout.tagLimit));
  }
  footer.append(tags);

  body.append(footer);
  card.append(body);

  card.addEventListener('dblclick', (event) => {
    // Two quick presses on a tag chip are two filter clicks, not a trip to the site.
    if (event.target instanceof Element && event.target.closest('.chip') !== null) return;
    callbacks.openOriginal(item);
  });

  return card;
}

