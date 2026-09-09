/**
 * The reader: `index.html?id=<itemId>`, opened in a new tab from the list.
 *
 * Everything happens locally. The only outbound traffic is images from the
 * original, and a single toggle turns it off ("don't load remote images").
 * Content enters the DOM only as a fragment that went through DOMPurify - no
 * `innerHTML`, no inline scripts, the CSP stays at its default
 * (CLAUDE.md 3, 5.6).
 */
import browser from 'webextension-polyfill';

import { announceChange, onDataChanged } from '@/lib/changes';
import {
  addHighlight,
  deleteHighlight,
  getContent,
  getItem,
  listHighlights,
  updateHighlight,
  updateItem,
  type Highlight,
  type SavedItem,
} from '@/lib/db';
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
import { showToast } from '@/ui/shared/toast';

import {
  buildTextMap,
  locate,
  makeAnchor,
  offsetsFromRange,
  unwrapHighlight,
  wrapRange,
  type Anchor,
} from './highlight';

/** Past this fraction of the content we consider the article read. */
const READ_THRESHOLD = 0.9;
const PROGRESS_SAVE_MS = 1_200;
const SCROLL_STEP = 120;

const el = {
  bar: document.querySelector<HTMLDivElement>('#progress-bar'),
  article: document.querySelector<HTMLElement>('#article'),
  back: document.querySelector<HTMLButtonElement>('#back'),
  favorite: document.querySelector<HTMLButtonElement>('#favorite'),
  archive: document.querySelector<HTMLButtonElement>('#archive'),
  original: document.querySelector<HTMLAnchorElement>('#original'),
  settingsToggle: document.querySelector<HTMLButtonElement>('#settings-toggle'),
  settings: document.querySelector<HTMLDivElement>('#settings'),
  fontSizeValue: document.querySelector<HTMLOutputElement>('#font-size-value'),
  columnValue: document.querySelector<HTMLOutputElement>('#column-value'),
  remoteImages: document.querySelector<HTMLInputElement>('#remote-images'),
  popover: document.querySelector<HTMLDivElement>('#popover'),
  toast: document.querySelector<HTMLDivElement>('#toast'),
};

let item: SavedItem | null = null;
let settings: ReaderSettings = { ...DEFAULT_SETTINGS };
let highlights: Highlight[] = [];
let markedRead = false;

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

/**
 * Shorter than the list's five seconds: a toast here only ever confirms
 * something that already happened, and there is nothing to take back.
 */
const TOAST_MS = 2_500;

function toast(message: string): void {
  if (el.toast !== null) showToast(el.toast, { message, durationMs: TOAST_MS });
}

function message(text: string): void {
  if (el.article === null) return;
  const paragraph = document.createElement('p');
  paragraph.className = 'loading';
  paragraph.textContent = text;
  el.article.replaceChildren(paragraph);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function applySettings(next: ReaderSettings): void {
  settings = next;
  const root = document.documentElement;

  root.style.setProperty('--font-size', `${String(next.fontSize)}px`);
  root.style.setProperty('--column-width', `${String(next.columnWidth)}ch`);
  root.dataset['family'] = next.fontFamily;
  root.dataset['theme'] = next.theme;

  if (el.fontSizeValue !== null) el.fontSizeValue.value = String(next.fontSize);
  if (el.columnValue !== null) el.columnValue.value = String(next.columnWidth);
  if (el.remoteImages !== null) el.remoteImages.checked = !next.remoteImages;

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-font-family]')) {
    button.setAttribute('aria-pressed', String(button.dataset['fontFamily'] === next.fontFamily));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset['themeChoice'] === next.theme));
  }

  applyImagePolicy();
}

/**
 * Privacy: with images turned off we strip `src` but remember it in `data-src`,
 * so turning them back on does not require reloading the page.
 */
function applyImagePolicy(): void {
  if (el.article === null) return;

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
  el.settingsToggle?.addEventListener('click', () => {
    if (el.settings === null) return;
    const open = el.settings.hidden;
    el.settings.hidden = !open;
    el.settingsToggle?.setAttribute('aria-expanded', String(open));
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

  el.remoteImages?.addEventListener('change', () => {
    void patchSettings({ remoteImages: !(el.remoteImages?.checked ?? false) });
  });

  // A change made in another tab should land here without a reload.
  onSettingsChanged(applySettings);
}

// ---------------------------------------------------------------------------
// Reading progress
// ---------------------------------------------------------------------------

function scrollRatio(): number {
  const root = document.documentElement;
  const scrollable = root.scrollHeight - root.clientHeight;
  if (scrollable <= 0) return 1;
  return Math.min(1, Math.max(0, root.scrollTop / scrollable));
}

let saveTimer: number | undefined;

function onScroll(): void {
  const ratio = scrollRatio();
  if (el.bar !== null) el.bar.style.width = `${String(Math.round(ratio * 100))}%`;

  if (item === null) return;

  if (!markedRead && ratio >= READ_THRESHOLD && item.readAt === null) {
    markedRead = true;
    void updateItem(item.id, { readAt: Date.now() }).then(announceChange);
  }

  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistProgress();
  }, PROGRESS_SAVE_MS) as unknown as number;
}

async function persistProgress(): Promise<void> {
  if (item === null) return;
  await updateItem(item.id, { readingProgress: scrollRatio() });
}

function restoreScroll(): void {
  if (item === null || item.readingProgress <= 0) return;
  const root = document.documentElement;
  const scrollable = root.scrollHeight - root.clientHeight;
  if (scrollable <= 0) return;
  root.scrollTop = item.readingProgress * scrollable;
}

// ---------------------------------------------------------------------------
// Selection and highlights
// ---------------------------------------------------------------------------

function popoverButton(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popover__action';
  button.textContent = label;
  button.addEventListener('mousedown', (event) => {
    // `mousedown`, because clicking the button clears the selection before `click`.
    event.preventDefault();
    run();
  });
  return button;
}

function hidePopover(): void {
  if (el.popover === null) return;
  el.popover.hidden = true;
  el.popover.replaceChildren();
}

function showPopover(rect: DOMRect, children: readonly HTMLElement[]): void {
  if (el.popover === null) return;

  el.popover.replaceChildren(...children);
  el.popover.hidden = false;

  const width = el.popover.offsetWidth;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    document.documentElement.clientWidth - width - 8,
  );
  const above = rect.top - el.popover.offsetHeight - 8;
  el.popover.style.left = `${String(left)}px`;
  el.popover.style.top = `${String(above > 8 ? above : rect.bottom + 8)}px`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('The browser refused to copy.');
  }
}

/** Database record -> anchor for the highlight module (where the quote is called `quote`). */
function anchorOf(highlight: Highlight): Anchor {
  return {
    start: highlight.start,
    end: highlight.end,
    quote: highlight.text,
    prefix: highlight.prefix,
    suffix: highlight.suffix,
  };
}

/** Repaints one highlight in the content. `false` when the quote is gone. */
function paint(highlight: Highlight): boolean {
  if (el.article === null) return false;

  const map = buildTextMap(el.article);
  const found = locate(map.text, anchorOf(highlight));
  if (found === null) return false;

  const marks = wrapRange(map, found, highlight.id);
  for (const mark of marks) {
    if (highlight.note !== null && highlight.note !== '') mark.title = highlight.note;
    mark.classList.toggle('hl--noted', highlight.note !== null && highlight.note !== '');
  }
  return marks.length > 0;
}

async function restoreHighlights(itemId: string): Promise<void> {
  highlights = await listHighlights(itemId);

  const lost = highlights.filter((highlight) => !paint(highlight)).length;
  if (lost > 0) {
    toast(`Could not restore ${String(lost)} highlight(s) - the content has changed.`);
  }
}

function noteEditor(highlight: Highlight): HTMLElement {
  const form = document.createElement('form');
  form.className = 'popover__note';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'popover__input';
  input.placeholder = 'Note';
  input.value = highlight.note ?? '';
  input.setAttribute('aria-label', 'Note for the selection');

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'popover__action';
  save.textContent = 'Save';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const note = input.value.trim() === '' ? null : input.value.trim();
    void updateHighlight(highlight.id, { note }).then((updated) => {
      highlights = highlights.map((entry) => (entry.id === updated.id ? updated : entry));
      if (el.article !== null) {
        for (const mark of el.article.querySelectorAll<HTMLElement>(
          `mark[data-highlight="${updated.id}"]`,
        )) {
          mark.title = note ?? '';
          mark.classList.toggle('hl--noted', note !== null);
        }
      }
      hidePopover();
      toast(note === null ? 'Note removed.' : 'Note saved.');
    });
  });

  form.append(input, save);
  setTimeout(() => {
    input.focus();
  }, 0);
  return form;
}

async function createHighlight(range: Range, withNote: boolean): Promise<void> {
  if (el.article === null || item === null) return;

  const map = buildTextMap(el.article);
  const offsets = offsetsFromRange(map, range);
  if (offsets === null) {
    toast('This selection cannot be anchored.');
    return;
  }

  const anchor = makeAnchor(map, offsets);
  const highlight = await addHighlight({
    itemId: item.id,
    text: anchor.quote,
    start: anchor.start,
    end: anchor.end,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
  });

  highlights = [...highlights, highlight];
  window.getSelection()?.removeAllRanges();
  paint(highlight);

  if (!withNote) {
    hidePopover();
    toast('Highlighted.');
    return;
  }

  const mark = el.article.querySelector<HTMLElement>(`mark[data-highlight="${highlight.id}"]`);
  if (mark === null) {
    hidePopover();
    return;
  }
  showPopover(mark.getBoundingClientRect(), [noteEditor(highlight)]);
}

function onSelectionChange(): void {
  if (el.article === null) return;

  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!el.article.contains(range.commonAncestorContainer)) return;

  const text = selection.toString().trim();
  if (text === '') return;

  showPopover(range.getBoundingClientRect(), [
    popoverButton('Highlight', () => {
      void createHighlight(range.cloneRange(), false);
    }),
    popoverButton('Copy', () => {
      void copyText(text);
      hidePopover();
    }),
    popoverButton('Note', () => {
      void createHighlight(range.cloneRange(), true);
    }),
  ]);
}

function onArticleClick(event: MouseEvent): void {
  const mark = (event.target as Element | null)?.closest<HTMLElement>('mark[data-highlight]');
  if (mark === null || mark === undefined) return;

  const id = mark.dataset['highlight'];
  const highlight = highlights.find((entry) => entry.id === id);
  if (highlight === undefined) return;

  event.preventDefault();
  showPopover(mark.getBoundingClientRect(), [
    popoverButton('Note', () => {
      showPopover(mark.getBoundingClientRect(), [noteEditor(highlight)]);
    }),
    popoverButton('Copy', () => {
      void copyText(highlight.text);
      hidePopover();
    }),
    popoverButton('Delete', () => {
      void deleteHighlight(highlight.id).then(() => {
        highlights = highlights.filter((entry) => entry.id !== highlight.id);
        if (el.article !== null) unwrapHighlight(el.article, highlight.id);
        hidePopover();
        toast('Highlight removed.');
      });
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Item actions and keyboard
// ---------------------------------------------------------------------------

function renderItemState(): void {
  if (item === null) return;
  el.favorite?.setAttribute('aria-pressed', String(item.favorite));
  if (el.favorite !== null) el.favorite.textContent = item.favorite ? '★' : '☆';
  el.archive?.setAttribute('aria-pressed', String(item.archived));
  if (el.archive !== null) el.archive.textContent = item.archived ? '↩' : '▤';
}

async function toggleFavorite(): Promise<void> {
  if (item === null) return;
  item = await updateItem(item.id, { favorite: !item.favorite });
  renderItemState();
  announceChange();
  toast(item.favorite ? 'Added to favorites.' : 'Removed from favorites.');
}

async function toggleArchive(): Promise<void> {
  if (item === null) return;
  item = await updateItem(item.id, { archived: !item.archived });
  renderItemState();
  announceChange();
  toast(item.archived ? 'Archived.' : 'Restored from the archive.');
}

/**
 * The same article, changed somewhere else - archived from the list, or pulled
 * in by a sync. Only the item is re-read: the article on screen is the one
 * being read, and re-rendering it would take the reader's place on the page
 * with it. What this fixes is the header lying, and the next toggle being
 * computed from a state that is two changes old.
 */
async function refreshItemState(): Promise<void> {
  if (item === null) return;
  const current = await getItem(item.id);
  // Deleted elsewhere: what is on screen still reads fine, and saying so in a
  // toast the reader did not ask for would help nobody.
  if (current === undefined) return;
  item = current;
  renderItemState();
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
    if (event.key === 'Escape') hidePopover();
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
      if (el.popover !== null && !el.popover.hidden) {
        hidePopover();
        return;
      }
      void closeTab();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

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
  if (el.article === null) return;

  wireSettings();
  applySettings(await loadSettings());

  el.back?.addEventListener('click', openList);
  el.favorite?.addEventListener('click', () => {
    void toggleFavorite();
  });
  el.archive?.addEventListener('click', () => {
    void toggleArchive();
  });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', () => {
    // A short delay: `selectionchange` also fires while dragging the mouse.
    setTimeout(onSelectionChange, 150);
  });
  document.addEventListener('mousedown', (event) => {
    if (el.popover !== null && !el.popover.contains(event.target as Node)) hidePopover();
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
  if (el.original !== null) el.original.href = loaded.resolvedUrl;
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
  body.addEventListener('click', onArticleClick);
  el.article.append(body);

  applyImagePolicy();
  await restoreHighlights(loaded.id);

  restoreScroll();
  // Images load later and change the page height - once they are in, we jump
  // back to the remembered position one more time.
  window.addEventListener('load', restoreScroll, { once: true });
  onScroll();
}

void main();
