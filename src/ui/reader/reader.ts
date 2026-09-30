import browser from 'webextension-polyfill';

import { onDataChanged } from '@/lib/changes';
import {
  getContent,
  getItem,
  saveReadingProgress,
  toggleItem,
  updateItem,
  type SavedItem,
} from '@/lib/library';
import { sanitizeToFragment } from '@/lib/sanitize';
import {
  COLUMN_WIDTH_RANGE,
  DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type FontFamily,
  type ReaderSettings,
  type Theme,
} from '@/lib/settings';
import { formatDomain, formatReadingTime, formatSavedAt } from '@/ui/shared/format';

import { Annotations } from './annotations';
import { required } from '@/ui/shared/dom';
import { showToast } from '@/ui/shared/toast';


const READ_THRESHOLD = 0.9;
const PROGRESS_SAVE_MS = 1_200;
const SCROLL_STEP = 120;

const el = {
  bar: required<HTMLDivElement>('#progress-bar'),
  article: required<HTMLElement>('#article'),
  back: required<HTMLButtonElement>('#back'),
  favorite: required<HTMLButtonElement>('#favorite'),
  archive: required<HTMLButtonElement>('#archive'),
  original: required<HTMLAnchorElement>('#original'),
  settingsToggle: required<HTMLButtonElement>('#settings-toggle'),
  settings: required<HTMLDivElement>('#settings'),
  fontSizeValue: required<HTMLOutputElement>('#font-size-value'),
  columnValue: required<HTMLOutputElement>('#column-value'),
  remoteImages: required<HTMLInputElement>('#remote-images'),
  popover: required<HTMLDivElement>('#popover'),
  toast: required<HTMLDivElement>('#toast'),
};

let item: SavedItem | null = null;
let settings: ReaderSettings = { ...DEFAULT_SETTINGS };
let markedRead = false;

const annotations = new Annotations({
  article: el.article,
  popover: el.popover,
  notify: toast,
});


const TOAST_MS = 2_500;

function toast(message: string): void {
  showToast(el.toast, { message, durationMs: TOAST_MS });
}

function message(text: string): void {
  const paragraph = document.createElement('p');
  paragraph.className = 'loading';
  paragraph.textContent = text;
  el.article.replaceChildren(paragraph);
}


function applySettings(next: ReaderSettings): void {
  settings = next;
  const root = document.documentElement;

  root.style.setProperty('--font-size', `${String(next.fontSize)}px`);
  root.style.setProperty('--column-width', `${String(next.columnWidth)}ch`);
  root.dataset['family'] = next.fontFamily;
  root.dataset['theme'] = next.theme;

  el.fontSizeValue.value = String(next.fontSize);
  el.columnValue.value = String(next.columnWidth);
  el.remoteImages.checked = !next.remoteImages;

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-font-family]')) {
    button.setAttribute('aria-pressed', String(button.dataset['fontFamily'] === next.fontFamily));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset['themeChoice'] === next.theme));
  }

  applyImagePolicy();
}

function applyImagePolicy(): void {
  for (const image of el.article.querySelectorAll('img')) {
    const current = image.getAttribute('src');
    if (settings.remoteImages) {
      const saved = image.dataset['src'];
      if (saved !== undefined && current === null) image.setAttribute('src', saved);
      image.classList.remove('blocked');
    } else {
      if (current !== null) image.dataset['src'] = current;
      image.removeAttribute('src');
      image.classList.add('blocked');
    }
  }
}

async function patchSettings(patch: Partial<ReaderSettings>): Promise<void> {
  applySettings(await saveSettings(patch));
}

function wireSettings(): void {
  el.settingsToggle.addEventListener('click', () => {
    const open = el.settings.hidden;
    el.settings.hidden = !open;
    el.settingsToggle.setAttribute('aria-expanded', String(open));
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-font-size]')) {
    button.addEventListener('click', () => {
      const step = Number(button.dataset['fontSize']);
      const value = Math.min(
        Math.max(settings.fontSize + step, FONT_SIZE_RANGE.min),
        FONT_SIZE_RANGE.max,
      );
      void patchSettings({ fontSize: value });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-column]')) {
    button.addEventListener('click', () => {
      const step = Number(button.dataset['column']);
      const value = Math.min(
        Math.max(settings.columnWidth + step, COLUMN_WIDTH_RANGE.min),
        COLUMN_WIDTH_RANGE.max,
      );
      void patchSettings({ columnWidth: value });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-font-family]')) {
    button.addEventListener('click', () => {
      void patchSettings({ fontFamily: button.dataset['fontFamily'] as FontFamily });
    });
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    button.addEventListener('click', () => {
      void patchSettings({ theme: button.dataset['themeChoice'] as Theme });
    });
  }

  el.remoteImages.addEventListener('change', () => {
    void patchSettings({ remoteImages: !el.remoteImages.checked });
  });

  onSettingsChanged(applySettings);
}


function scrollRatio(): number {
  const root = document.documentElement;
  const scrollable = root.scrollHeight - root.clientHeight;
  if (scrollable <= 0) return 1;
  return Math.min(1, Math.max(0, root.scrollTop / scrollable));
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function onScroll(): void {
  const ratio = scrollRatio();
  el.bar.style.width = `${String(Math.round(ratio * 100))}%`;

  if (item === null) return;

  if (!markedRead && ratio >= READ_THRESHOLD && item.readAt === null) {
    markedRead = true;
    void updateItem(item.id, { readAt: Date.now() });
  }

  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistProgress();
  }, PROGRESS_SAVE_MS);
}

async function persistProgress(): Promise<void> {
  if (item === null) return;
  await saveReadingProgress(item.id, scrollRatio());
}

function restoreScroll(): void {
  if (item === null || item.readingProgress <= 0) return;
  const root = document.documentElement;
  const scrollable = root.scrollHeight - root.clientHeight;
  if (scrollable <= 0) return;
  root.scrollTop = item.readingProgress * scrollable;
}


function renderItemState(): void {
  if (item === null) return;
  el.favorite.setAttribute('aria-pressed', String(item.favorite));
  el.favorite.textContent = item.favorite ? '★' : '☆';
  el.archive.setAttribute('aria-pressed', String(item.archived));
  el.archive.textContent = item.archived ? '↩' : '▤';
}

async function toggleFavorite(): Promise<void> {
  if (item === null) return;
  item = await toggleItem(item.id, 'favorite');
  renderItemState();
  toast(item.favorite ? 'Added to favorites.' : 'Removed from favorites.');
}

async function toggleArchive(): Promise<void> {
  if (item === null) return;
  item = await toggleItem(item.id, 'archived');
  renderItemState();
  toast(item.archived ? 'Archived.' : 'Restored from the archive.');
}

async function refreshItemState(): Promise<void> {
  if (item === null) return;
  const current = await getItem(item.id);
  if (current === undefined) return;
  item = current;
  renderItemState();
  await annotations.reload();
}

function openList(): void {
  location.assign(`${browser.runtime.getURL('ui/list/list.html')}?full=1`);
}

async function closeTab(): Promise<void> {
  const current = await browser.tabs.getCurrent();
  if (current?.id === undefined) {
    window.close();
    return;
  }
  await browser.tabs.remove(current.id);
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (event.key === 'Escape') annotations.hide();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  switch (event.key) {
    case 'j':
      event.preventDefault();
      window.scrollBy({ top: SCROLL_STEP });
      break;
    case 'k':
      event.preventDefault();
      window.scrollBy({ top: -SCROLL_STEP });
      break;
    case 'a':
      void toggleArchive();
      break;
    case 'f':
      void toggleFavorite();
      break;
    case 'o':
      if (item !== null) void browser.tabs.create({ url: item.resolvedUrl });
      break;
    case 'Escape':
      if (annotations.isOpen) {
        annotations.hide();
        return;
      }
      void closeTab();
      break;
    default:
      break;
  }
}


function renderHeader(loaded: SavedItem): HTMLElement {
  const header = document.createElement('header');
  header.className = 'header';

  const title = document.createElement('h1');
  title.className = 'title';
  title.textContent = loaded.title === '' ? formatDomain(loaded.url) : loaded.title;
  header.append(title);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [
    loaded.byline,
    formatDomain(loaded.url),
    formatReadingTime(loaded.estReadingMinutes),
    `saved ${formatSavedAt(loaded.savedAt)}`,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  header.append(meta);

  return header;
}

async function main(): Promise<void> {
  wireSettings();
  applySettings(await loadSettings());

  el.back.addEventListener('click', openList);
  el.favorite.addEventListener('click', () => {
    void toggleFavorite();
  });
  el.archive.addEventListener('click', () => {
    void toggleArchive();
  });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', () => {
    setTimeout(() => {
      annotations.onSelectionChange();
    }, 150);
  });
  document.addEventListener('mousedown', (event) => {
    if (!annotations.contains(event.target as Node)) annotations.hide();
  });
  window.addEventListener('scroll', () => {
    requestAnimationFrame(onScroll);
  });
  window.addEventListener('pagehide', () => {
    void persistProgress();
  });
  onDataChanged(() => {
    void refreshItemState();
  });

  const id = new URLSearchParams(location.search).get('id');
  if (id === null) {
    message('The address has no item identifier.');
    return;
  }

  const loaded = await getItem(id);
  if (loaded === undefined) {
    message('No such item - it may have been deleted.');
    return;
  }
  item = loaded;
  markedRead = loaded.readAt !== null;

  document.title = `${loaded.title} - Savely`;
  el.original.href = loaded.resolvedUrl;
  renderItemState();

  const content = await getContent(loaded.id);
  el.article.replaceChildren(renderHeader(loaded));

  if (content === undefined) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent =
      loaded.excerpt === ''
        ? 'This item has no stored content - open the original.'
        : `${loaded.excerpt}\n\nThe content could not be extracted - open the original.`;
    el.article.append(note);
    onScroll();
    return;
  }

  const body = document.createElement('div');
  body.className = 'content';
  body.append(sanitizeToFragment(content.html, loaded.resolvedUrl));
  body.addEventListener('click', (event) => {
    annotations.onArticleClick(event);
  });
  el.article.append(body);

  applyImagePolicy();
  await annotations.load(loaded.id);

  restoreScroll();
  window.addEventListener('load', restoreScroll, { once: true });
  onScroll();
}

void main();
