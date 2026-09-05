/**
 * Building an item card.
 *
 * The whole UI is assembled with `createElement` + `textContent` - no
 * `innerHTML` with user data or page data (CLAUDE.md 3).
 */
import type { SavedItem } from '@/lib/db';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from './format';

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
  return element;
}

export function createCard(item: SavedItem, index: number, callbacks: CardCallbacks): HTMLLIElement {
  const card = document.createElement('li');
  card.className = 'card';
  card.dataset['id'] = item.id;
  card.dataset['index'] = String(index);
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', 'false');
  card.tabIndex = -1;

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
    formatReadingTime(item.estReadingMinutes),
    formatSavedAt(item.savedAt),
    formatStatus(item.status),
  ].filter((part) => part !== '');
  meta.textContent = parts.join(' · ');
  body.append(meta);

  const footer = document.createElement('div');
  footer.className = 'card__footer';

  const tags = document.createElement('div');
  tags.className = 'card__tags';
  for (const tag of item.tags.slice(0, 3)) {
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
  if (item.tags.length > 3) {
    const more = document.createElement('span');
    more.className = 'chip chip--muted';
    more.textContent = `+${String(item.tags.length - 3)}`;
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
    button('Read (Enter)', '▶', () => {
      callbacks.openReader(item);
    }),
    button('Open original (o)', '↗', () => {
      callbacks.openOriginal(item);
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

/** The first image in the stored content - the source of the thumbnail. */
export function findLeadImage(html: string): string | null {
  const match = /<img\b[^>]*\bsrc="(https?:\/\/[^"]+)"/i.exec(html);
  return match?.[1] ?? null;
}
