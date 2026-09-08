/**
 * The list of saved items - the same file drives the popup and the full page
 * (`list.html?full=1`). The differences live in one place (`MODE` below):
 * the popup is capped at 600 px, shows the 20 most recent items and ends with
 * a "See all" button.
 *
 * Every item (without content) is loaded into memory once and filtered there -
 * metadata for 5000 articles is a few megabytes, which makes switching a tab
 * or a tag instant. Content is read on demand only, for the search index.
 */
import browser from 'webextension-polyfill';

import {
  deleteItem,
  getContents,
  listContentIds,
  listFavicons,
  listItems,
  restoreItem,
  updateItem,
  type RemovedItem,
  type SavedItem,
} from '@/lib/db';
import { faviconKey } from '@/lib/favicon';
import { isSaveResultMessage } from '@/lib/guards';
import { SearchIndex } from '@/lib/search';
import { DEFAULT_SETTINGS, type Theme } from '@/lib/settings';
import { THEME_ICONS, THEME_LABELS, initTheme, nextTheme, setTheme } from '@/lib/theme';
import { SAVE_ACTIVE_TAB } from '@/types/messages';

import { createCard, type CardCallbacks } from './cards';
import { closeTagEditor, openTagEditor } from './tags';
import { showToast } from './toast';
import { computeWindow, scrollTopFor } from './window';

type TabId = 'inbox' | 'favorite' | 'archive';

const OVERSCAN = 4;
const POPUP_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 150;
const UNDO_MS = 5_000;
/** Content batch size while building the index - small enough to keep the UI responsive. */
const INDEX_BATCH = 150;

const MODE: 'popup' | 'full' =
  new URLSearchParams(location.search).get('full') === '1' ? 'full' : 'popup';

interface PendingDelete {
  item: SavedItem;
  /** What the database gave back when it removed the item - what Undo puts in again. */
  removed: Promise<RemovedItem | null>;
}

const state = {
  items: [] as SavedItem[],
  visible: [] as SavedItem[],
  tab: 'inbox' as TabId,
  query: '',
  tags: [] as string[],
  selected: -1,
  pending: new Map<string, PendingDelete>(),
};

/**
 * Row height is a contract between the CSS and the virtualization, and at
 * 360 px a card grows (actions move below the tags). That is why the value
 * lives in CSS (`--row-h`) and is only read here - and re-read on resize.
 */
function readRowHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 104;
}

let rowHeight = 104;

const index = new SearchIndex();
/** domain -> `data:` URL, read once at startup; see `loadFavicons`. */
let favicons = new Map<string, string>();

const el = {
  app: document.body,
  search: document.querySelector<HTMLInputElement>('#search'),
  scroller: document.querySelector<HTMLDivElement>('#scroller'),
  sizer: document.querySelector<HTMLDivElement>('#sizer'),
  rows: document.querySelector<HTMLUListElement>('#rows'),
  empty: document.querySelector<HTMLParagraphElement>('#empty'),
  tabs: [...document.querySelectorAll<HTMLButtonElement>('.tab')],
  activeTags: document.querySelector<HTMLDivElement>('#active-tags'),
  footer: document.querySelector<HTMLElement>('#footer'),
  seeAll: document.querySelector<HTMLButtonElement>('#see-all'),
  save: document.querySelector<HTMLButtonElement>('#save'),
  status: document.querySelector<HTMLParagraphElement>('#status'),
  toast: document.querySelector<HTMLDivElement>('#toast'),
  tagEditor: document.querySelector<HTMLDivElement>('#tag-editor'),
  help: document.querySelector<HTMLDialogElement>('#help-dialog'),
  helpButton: document.querySelector<HTMLButtonElement>('#help'),
  optionsButton: document.querySelector<HTMLButtonElement>('#options'),
  themeButton: document.querySelector<HTMLButtonElement>('#theme'),
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadItems(): Promise<void> {
  const all: SavedItem[] = [];
  let cursor: string | null = null;

  do {
    const page: Awaited<ReturnType<typeof listItems>> = await listItems({ limit: 500, cursor });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null && all.length < 20_000);

  state.items = all;
}

/**
 * The index is built in two stages: titles and excerpts first (they are in
 * memory, so search works immediately), then - on the full page only - the
 * content read from the database in batches. There is no reason for the popup
 * to pull in megabytes of content just to show 20 items.
 */
function indexMetadata(): void {
  index.clear();
  for (const item of state.items) {
    index.addItem({ id: item.id, title: item.title, excerpt: item.excerpt });
  }
}

async function indexContents(): Promise<void> {
  const ids = await listContentIds();

  for (let offset = 0; offset < ids.length; offset += INDEX_BATCH) {
    const batch = await getContents(ids.slice(offset, offset + INDEX_BATCH));
    for (const content of batch) {
      index.setText(content.itemId, content.text);
    }
    // Yield to the browser so the list stays responsive.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  if (state.query !== '') recompute();
}

// ---------------------------------------------------------------------------
// Filtering and rendering
// ---------------------------------------------------------------------------

function matchesTab(item: SavedItem): boolean {
  switch (state.tab) {
    case 'inbox':
      return !item.archived;
    case 'favorite':
      return item.favorite;
    case 'archive':
      return item.archived;
  }
}

function matchesTags(item: SavedItem): boolean {
  return state.tags.every((tag) => item.tags.includes(tag));
}

function knownTags(): string[] {
  const all = new Set<string>();
  for (const item of state.items) for (const tag of item.tags) all.add(tag);
  return [...all].sort();
}

function recompute(): void {
  const base = state.items.filter((item) => matchesTab(item) && matchesTags(item));

  let visible = base;
  if (state.query.trim() !== '') {
    // Search is scoped to the current tab - otherwise an archived result would
    // show up in the inbox and vice versa.
    const ranking = new Map(index.search(state.query, 500).map((id, position) => [id, position]));
    visible = base
      .filter((item) => ranking.has(item.id))
      .sort((a, b) => (ranking.get(a.id) ?? 0) - (ranking.get(b.id) ?? 0));
  }

  state.visible = MODE === 'popup' ? visible.slice(0, POPUP_LIMIT) : visible;
  state.selected = Math.min(state.selected, state.visible.length - 1);

  renderCounts(visible.length);
  renderActiveTags();
  render(true);
}

function renderCounts(filteredTotal: number): void {
  const counts: Record<TabId, number> = {
    inbox: state.items.filter((item) => !item.archived).length,
    favorite: state.items.filter((item) => item.favorite).length,
    archive: state.items.filter((item) => item.archived).length,
  };

  for (const tab of el.tabs) {
    const id = tab.dataset['tab'] as TabId | undefined;
    if (id === undefined) continue;
    tab.setAttribute('aria-selected', String(id === state.tab));
    const badge = tab.querySelector('.tab__count');
    if (badge !== null) badge.textContent = String(counts[id]);
  }

  if (el.footer !== null && el.seeAll !== null) {
    const hidden = MODE === 'full' || filteredTotal <= state.visible.length;
    el.footer.hidden = hidden;
    el.seeAll.textContent =
      filteredTotal > POPUP_LIMIT
        ? `See all (${String(filteredTotal)})`
        : 'See all';
  }
}

function renderActiveTags(): void {
  if (el.activeTags === null) return;

  el.activeTags.replaceChildren();
  el.activeTags.hidden = state.tags.length === 0;

  for (const tag of state.tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip chip--removable';
    chip.textContent = `#${tag} ✕`;
    chip.title = `Stop filtering by #${tag}`;
    chip.addEventListener('click', () => {
      state.tags = state.tags.filter((value) => value !== tag);
      recompute();
    });
    el.activeTags.append(chip);
  }
}

let lastRange = { start: -1, end: -1 };

function render(force = false): void {
  const { scroller, sizer, rows, empty } = el;
  if (scroller === null || sizer === null || rows === null || empty === null) return;

  const range = computeWindow({
    scrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
    total: state.visible.length,
    rowHeight,
    overscan: OVERSCAN,
  });

  sizer.style.height = `${String(range.totalHeight)}px`;
  empty.hidden = state.visible.length > 0;
  if (state.visible.length === 0) empty.textContent = emptyMessage();

  if (!force && range.start === lastRange.start && range.end === lastRange.end) return;
  lastRange = { start: range.start, end: range.end };

  const cards: HTMLLIElement[] = [];
  for (let position = range.start; position < range.end; position += 1) {
    const item = state.visible[position];
    if (item === undefined) continue;
    const card = createCard(item, position, callbacks);
    if (position === state.selected) card.setAttribute('aria-selected', 'true');
    applyFavicon(card, item);
    cards.push(card);
  }

  rows.replaceChildren(...cards);
  rows.style.transform = `translateY(${String(range.offsetY)}px)`;
}

function emptyMessage(): string {
  if (state.query.trim() !== '') return `No results for \u201c${state.query.trim()}\u201d.`;
  if (state.tags.length > 0) return 'No item has all of the selected tags.';
  switch (state.tab) {
    case 'inbox':
      return 'Nothing here yet. Save your first page.';
    case 'favorite':
      return 'No favorites.';
    case 'archive':
      return 'The archive is empty.';
  }
}

// ---------------------------------------------------------------------------
// Site icons
// ---------------------------------------------------------------------------

/**
 * All the icons in one read, before the first render.
 *
 * There is one row per domain rather than per item, so this is tens of rows
 * even for a database of thousands of articles - cheaper than the card-by-card
 * reads the lead-image thumbnail used to need, and it lands before the cards
 * are drawn, so nothing shifts a moment later.
 */
async function loadFavicons(): Promise<void> {
  favicons = await listFavicons();
}

function applyFavicon(card: HTMLLIElement, item: SavedItem): void {
  const domain = faviconKey(item.url);
  const dataUrl = domain === null ? undefined : favicons.get(domain);
  if (dataUrl === undefined) return;

  const image = card.querySelector<HTMLImageElement>('.card__thumb');
  if (image === null) return;
  image.src = dataUrl;
  image.hidden = false;
}

// ---------------------------------------------------------------------------
// Item actions
// ---------------------------------------------------------------------------

function replaceItem(updated: SavedItem): void {
  state.items = state.items.map((item) => (item.id === updated.id ? updated : item));
  index.addItem({ id: updated.id, title: updated.title, excerpt: updated.excerpt });
  recompute();
}

function extensionUrl(path: string): string {
  return browser.runtime.getURL(path);
}

/** Always a new tab: the reader and the original must not swallow the list they came from. */
function openUrl(url: string): void {
  void browser.tabs.create({ url });
  if (MODE === 'popup') window.close();
}

const callbacks: CardCallbacks = {
  // No read marking here - the reader decides that after reaching 90% of the content.
  openReader(item) {
    openUrl(`${extensionUrl('ui/reader/index.html')}?id=${encodeURIComponent(item.id)}`);
  },

  openOriginal(item) {
    openUrl(item.resolvedUrl);
  },

  toggleArchive(item) {
    void updateItem(item.id, { archived: !item.archived }).then(replaceItem);
  },

  toggleFavorite(item) {
    void updateItem(item.id, { favorite: !item.favorite }).then(replaceItem);
  },

  editTags(item, anchor) {
    if (el.tagEditor === null) return;
    openTagEditor({
      host: el.tagEditor,
      anchor,
      key: item.id,
      tags: item.tags,
      known: knownTags(),
      apply: (tags) => {
        void updateItem(item.id, { tags }).then(replaceItem);
      },
    });
  },

  remove(item) {
    removeWithUndo(item);
  },

  filterByTag(tag) {
    if (!state.tags.includes(tag)) state.tags = [...state.tags, tag];
    recompute();
  },
};

/**
 * The item leaves the screen and the database at once; the toast offers five
 * seconds to put it back.
 *
 * The other way round - the item held in memory and written off only when the
 * toast expires - is what the popup cannot support. A popup is usually gone
 * within a second of the click, and its `pagehide` handler cannot finish an
 * IndexedDB transaction on the way out: the deletion the user watched happen
 * was simply back in the list the next time they opened it.
 *
 * So the database is told immediately and `deleteItem` answers with the record
 * it removed, which is what Undo puts back - content, highlights, grave and
 * all.
 */
function removeWithUndo(item: SavedItem): void {
  if (el.toast === null) return;

  state.items = state.items.filter((entry) => entry.id !== item.id);
  index.remove(item.id);
  recompute();

  const removed = deleteItem(item.id).catch((error: unknown) => {
    // Nothing awaits this until Undo, and an unhandled rejection would take the
    // whole handler down with it.
    console.error('[savely] the deletion did not reach the database:', error);
    return null;
  });
  state.pending.set(item.id, { item, removed });

  showToast(el.toast, {
    message: `Deleted “${item.title === '' ? item.url : item.title}”`,
    durationMs: UNDO_MS,
    action: {
      label: 'Undo',
      run: () => {
        void undoRemoval(item.id);
      },
    },
    onExpire: () => {
      // Nothing to carry out any more - the deletion is long done.
      state.pending.delete(item.id);
    },
  });
}

/** Puts the item back where it was, in the database first and then on screen. */
async function undoRemoval(id: string): Promise<void> {
  const pending = state.pending.get(id);
  if (pending === undefined) return;
  state.pending.delete(id);

  const removed = await pending.removed;
  if (removed !== null) await restoreItem(removed);

  const { item } = pending;
  state.items = [...state.items, item].sort((a, b) => b.savedAt - a.savedAt);
  index.addItem({ id: item.id, title: item.title, excerpt: item.excerpt });
  recompute();
}

// ---------------------------------------------------------------------------
// Selection and keyboard
// ---------------------------------------------------------------------------

function select(position: number): void {
  const scroller = el.scroller;
  if (scroller === null || state.visible.length === 0) return;

  state.selected = Math.min(Math.max(position, 0), state.visible.length - 1);

  const target = scrollTopFor(state.selected, scroller.scrollTop, scroller.clientHeight, rowHeight);
  if (target !== null) scroller.scrollTop = target;

  render(true);
  el.rows?.querySelector<HTMLLIElement>('[aria-selected="true"]')?.focus();
}

function selectedItem(): SavedItem | undefined {
  return state.visible[state.selected];
}

function toggleHelp(): void {
  const help = el.help;
  if (help === null) return;
  if (help.open) help.close();
  else help.showModal();
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  if (event.key === 'Escape') {
    closeTagEditor();
    if (typing && el.search !== null && target === el.search) {
      el.search.value = '';
      state.query = '';
      recompute();
      el.search.blur();
    }
    return;
  }

  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

  // A focused button answers Enter and Space itself, and the shortcut does not
  // merely fire on top of it: `preventDefault` below cancels the click the
  // browser was about to synthesize, so Enter on the delete button opened the
  // reader and deleted nothing. Whoever tabbed to a button meant that button.
  if ((event.key === 'Enter' || event.key === ' ') && target instanceof HTMLButtonElement) return;

  const item = selectedItem();

  switch (event.key) {
    case '/':
      event.preventDefault();
      el.search?.focus();
      return;
    case '?':
      event.preventDefault();
      toggleHelp();
      return;
    case 'ArrowDown':
      event.preventDefault();
      select(state.selected + 1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      select(state.selected - 1);
      return;
    case 'Home':
      event.preventDefault();
      select(0);
      return;
    case 'End':
      event.preventDefault();
      select(state.visible.length - 1);
      return;
    case '1':
      switchTab('inbox');
      return;
    case '2':
      switchTab('favorite');
      return;
    case '3':
      switchTab('archive');
      return;
    case 'd':
      cycleTheme();
      return;
    default:
      break;
  }

  if (item === undefined) return;

  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      callbacks.openReader(item);
      break;
    case 'o':
      callbacks.openOriginal(item);
      break;
    case 'a':
      callbacks.toggleArchive(item);
      break;
    case 'f':
      callbacks.toggleFavorite(item);
      break;
    case 't': {
      event.preventDefault();
      const anchor = el.rows?.querySelector<HTMLElement>('[aria-selected="true"] .card__actions');
      if (anchor !== null && anchor !== undefined) callbacks.editTags(item, anchor);
      break;
    }
    case 'Delete':
    case 'Backspace':
      event.preventDefault();
      callbacks.remove(item);
      break;
    default:
      break;
  }
}

function switchTab(tab: TabId): void {
  state.tab = tab;
  state.selected = -1;
  if (el.scroller !== null) el.scroller.scrollTop = 0;
  recompute();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * The list has room for one button, so the switcher cycles instead of showing
 * four options: the glyph says where we are, the label says where the next
 * click goes. The theme itself is applied by `initTheme` on <html>.
 */
let theme: Theme = DEFAULT_SETTINGS.theme;

function showTheme(next: Theme): void {
  theme = next;
  if (el.themeButton === null) return;

  const following = THEME_LABELS[nextTheme(next)];
  el.themeButton.textContent = THEME_ICONS[next];
  el.themeButton.title = `Theme: ${THEME_LABELS[next]} (switch to ${following})`;
  el.themeButton.setAttribute('aria-label', el.themeButton.title);
}

function cycleTheme(): void {
  // The button redraws before the write lands - the switch has to feel instant,
  // and `initTheme`'s listener corrects it if the write ends up somewhere else.
  const next = nextTheme(theme);
  showTheme(next);
  void setTheme(next);
}

// ---------------------------------------------------------------------------
// Saving from the popup
// ---------------------------------------------------------------------------

function showStatus(message: string, tone: 'ok' | 'error'): void {
  if (el.status === null) return;
  el.status.textContent = message;
  el.status.dataset['tone'] = tone;
  el.status.hidden = false;
}

async function saveCurrentPage(): Promise<void> {
  if (el.save === null) return;

  el.save.disabled = true;
  showStatus('Saving\u2026', 'ok');

  try {
    const response: unknown = await browser.runtime.sendMessage({ type: SAVE_ACTIVE_TAB });
    if (!isSaveResultMessage(response)) {
      showStatus('The background did not respond - please try again.', 'error');
      return;
    }
    showStatus(response.message, response.ok && !response.degraded ? 'ok' : 'error');
    if (response.ok) {
      // A save from a new site also brings a new icon.
      await Promise.all([loadItems(), loadFavicons()]);
      indexMetadata();
      recompute();
    }
  } catch {
    showStatus('Could not reach the extension background.', 'error');
  } finally {
    el.save.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function wireEvents(): void {
  el.app.dataset['mode'] = MODE;
  rowHeight = readRowHeight();

  window.addEventListener('resize', () => {
    const next = readRowHeight();
    if (next === rowHeight) return;
    rowHeight = next;
    render(true);
  });

  let searchTimer: number | undefined;
  el.search?.addEventListener('input', () => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search?.value ?? '';
      state.selected = -1;
      if (el.scroller !== null) el.scroller.scrollTop = 0;
      recompute();
    }, SEARCH_DEBOUNCE_MS) as unknown as number;
  });

  let frame = 0;
  el.scroller?.addEventListener('scroll', () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  });

  for (const tab of el.tabs) {
    tab.addEventListener('click', () => {
      const id = tab.dataset['tab'] as TabId | undefined;
      if (id !== undefined) switchTab(id);
    });
  }

  el.rows?.addEventListener('click', (event) => {
    const card = (event.target as Element | null)?.closest<HTMLLIElement>('.card');
    const position = card?.dataset['index'];
    if (position !== undefined) select(Number(position));
  });

  el.seeAll?.addEventListener('click', () => {
    openUrl(`${extensionUrl('ui/list/list.html')}?full=1`);
  });

  el.save?.addEventListener('click', () => {
    void saveCurrentPage();
  });

  el.helpButton?.addEventListener('click', toggleHelp);

  el.themeButton?.addEventListener('click', cycleTheme);

  // On Firefox for Android about:addons is the only alternative - hence the
  // entry point to the options page from the list as well (CLAUDE.md 5.6).
  el.optionsButton?.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  document.querySelector('#help-close')?.addEventListener('click', () => {
    el.help?.close();
  });

  document.addEventListener('keydown', onKeyDown);

}

async function main(): Promise<void> {
  wireEvents();

  // Not awaited with the data: the theme is one storage read, and the list must
  // not wait for it - `initTheme` also keeps the page in step with the reader.
  void initTheme(showTheme);

  await Promise.all([loadItems(), loadFavicons()]);
  indexMetadata();
  recompute();

  if (MODE === 'full') void indexContents();
}

void main();
