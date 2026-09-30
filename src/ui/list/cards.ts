import type { SavedItem } from '@/types/item';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from '@/ui/shared/format';
import { moreChip, tagChip } from './chips';

export interface CardCallbacks {
  openOriginal: (item: SavedItem) => void;
  filterByTag: (tag: string) => void;
}

export interface CardLayout {
  tagLimit: number;
  savedAt: boolean;
  readingTime: boolean;
}

export const CARD_LAYOUT: Record<'full' | 'popup', CardLayout> = {
  full: { tagLimit: 3, savedAt: true, readingTime: true },
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
    if (event.target instanceof Element && event.target.closest('.chip') !== null) return;
    callbacks.openOriginal(item);
  });

  return card;
}

