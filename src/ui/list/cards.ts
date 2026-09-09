/**
 * Building an item card.
 *
 * The whole UI is assembled with `createElement` + `textContent` - no
 * `innerHTML` with user data or page data (CLAUDE.md 3).
 */
import type { SavedItem } from '@/lib/db';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from '@/ui/shared/format';

export interface CardCallbacks {
  openReader: (item: SavedItem) => void;
  openOriginal: (item: SavedItem) => void;
  toggleArchive: (item: SavedItem) => void;
  toggleFavorite: (item: SavedItem) => void;
  editTags: (item: SavedItem, anchor: HTMLElement) => void;
  remove: (item: SavedItem) => void;
  filterByTag: (tag: string) => void;
}

function button(label: string, glyph: string, onClick: () => void, pressed?: boolean): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'icon';
  element.textContent = glyph;
  element.title = label;
  element.setAttribute('aria-label', label);
  if (pressed !== undefined) element.setAttribute('aria-pressed', String(pressed));
  element.addEventListener('click', (event) => {
    // The card as a whole opens the reader - a button must not trigger that too.
    event.stopPropagation();
    onClick();
  });
  // Two quick presses on a button are two presses of that button, nothing more:
  // without this the card's double click opens the reader on top of them.
  element.addEventListener('dblclick', (event) => {
    event.stopPropagation();
  });
  return element;
}

/**
 * What fits on a card. The same element serves both modes; the popup's row is
 * 64 px and one line wide, so it carries less of the same information - never
 * different information, and never fewer actions.
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
  // In the popup the metadata shares its line with the actions, so it is down
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
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `#${tag}`;
    chip.title = `Filter by #${tag}`;
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.filterByTag(tag);
    });
    tags.append(chip);
  }
  if (item.tags.length > layout.tagLimit) {
    const more = document.createElement('span');
    more.className = 'chip chip--muted';
    more.textContent = `+${String(item.tags.length - layout.tagLimit)}`;
    tags.append(more);
  }
  footer.append(tags);

  const actions = document.createElement('div');
  actions.className = 'card__actions';
  const tagButton = button('Tags (t)', '#', () => {
    callbacks.editTags(item, tagButton);
  });
  // The tag editor recognizes its own button by this - the cards are rebuilt on
  // every render, so the element itself is no lasting identity.
  tagButton.dataset['tagsFor'] = item.id;
  actions.append(
    button('Open original (o)', '↗', () => {
      callbacks.openOriginal(item);
    }),
    button('Read (Enter)', '▶', () => {
      callbacks.openReader(item);
    }),
    button(
      item.favorite ? 'Remove from favorites (f)' : 'Add to favorites (f)',
      item.favorite ? '★' : '☆',
      () => {
        callbacks.toggleFavorite(item);
      },
      item.favorite,
    ),
    button(
      item.archived ? 'Restore from archive (a)' : 'Archive (a)',
      item.archived ? '↩' : '▤',
      () => {
        callbacks.toggleArchive(item);
      },
      item.archived,
    ),
    tagButton,
    button('Delete (Delete)', '✕', () => {
      callbacks.remove(item);
    }),
  );
  footer.append(actions);

  body.append(footer);
  card.append(body);

  card.addEventListener('dblclick', () => {
    callbacks.openReader(item);
  });

  return card;
}

