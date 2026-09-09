/**
 * The list of saved items - the same file drives the popup and the full page
 * (`list.html?full=1`). The differences live in one place (`MODE` below):
 * the popup is capped at 600 px, shows the 20 most recent items and ends with
 * a "See all" button.
 *
 * Every item (without content) is loaded into memory once and filtered there -
 * metadata for 5000 articles is a few megabytes, which makes switching a tab
 * or a tag instant. Content is read on demand only, for the search index.
 *
 * What is on screen and why is `store.ts`; this file is the wiring between it
 * and the document. The store answers with a view, the page draws the view,
 * and every change goes back through the store - so there is one place that
 * decides what the list contains and one place that puts it on screen.
 */
import browser from 'webextension-polyfill';

import { announceChange, onDataChanged } from '@/lib/changes';
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
import { DEFAULT_SETTINGS, type Theme } from '@/lib/settings';
import { THEME_ICONS, THEME_LABELS, initTheme, nextTheme, setTheme } from '@/lib/theme';
import { SAVE_ACTIVE_TAB } from '@/types/messages';
import { required } from '@/ui/shared/dom';
import { showToast } from '@/ui/shared/toast';

import { CARD_LAYOUT, createCard, type CardCallbacks } from './cards';
import { tagChip } from './chips';
import { parseQuery } from './query';
import { ListStore, type ListView, type TabId } from './store';
import { closeTagEditor, openTagEditor } from './tags';
import { computeWindow, scrollTopFor } from './window';

const OVERSCAN = 4;
const POPUP_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 150;
const UNDO_MS = 5_000;
/** Content batch size while building the index - small enough to keep the UI responsive. */
const INDEX_BATCH = 150;

const MODE: 'popup' | 'full' =
  new URLSearchParams(location.search).get('full') === '1' ? 'full' : 'popup';

const store = new ListStore(MODE === 'popup' ? { limit: POPUP_LIMIT } : {});

interface PendingDelete {
  item: SavedItem;
  /** What the database gave back when it removed the item - what Undo puts in again. */
  removed: Promise<RemovedItem | null>;
}

/**
 * Deletions still inside their undo window. Not in the store: what is on screen
 * is decided the moment the item goes, and this is only what it would take to
 * bring it back.
 */
const pending = new Map<string, PendingDelete>();

/**
 * Row height is a contract between the CSS and the virtualization: the popup
 * has a compact card, and at 360 px the full page grows one (the actions move
 * below the tags). That is why the value lives in CSS (`--row-h`) and is only
 * read here - and re-read on resize.
 *
 * Read off `body`, not `:root`: the mode is an attribute on `body`, so that is
 * where the popup's override sits.
 */
function readRowHeight(): number {
  const raw = getComputedStyle(document.body).getPropertyValue('--row-h');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 104;
}

let rowHeight = 104;

/** domain -> `data:` URL, read once at startup; see `loadFavicons`. */
let favicons = new Map<string, string>();

const el = {
  app: document.body,
  search: required<HTMLInputElement>('#search'),
  scroller: required<HTMLDivElement>('#scroller'),
  sizer: required<HTMLDivElement>('#sizer'),
  rows: required<HTMLUListElement>('#rows'),
  empty: required<HTMLParagraphElement>('#empty'),
  tabs: [...document.querySelectorAll<HTMLButtonElement>('.tab')],
  activeTags: required<HTMLDivElement>('#active-tags'),
  footer: required<HTMLElement>('#footer'),
  seeAll: required<HTMLButtonElement>('#see-all'),
  save: required<HTMLButtonElement>('#save'),
  status: required<HTMLParagraphElement>('#status'),
  toast: required<HTMLDivElement>('#toast'),
  tagEditor: required<HTMLDivElement>('#tag-editor'),
  help: required<HTMLDialogElement>('#help-dialog'),
  helpButton: required<HTMLButtonElement>('#help'),
  optionsButton: required<HTMLButtonElement>('#options'),
  themeButton: required<HTMLButtonElement>('#theme'),
  helpClose: required<HTMLButtonElement>('#help-close'),
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadItems(): Promise<SavedItem[]> {
  const all: SavedItem[] = [];
  let cursor: string | null = null;

  do {
    const page: Awaited<ReturnType<typeof listItems>> = await listItems({ limit: 500, cursor });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null && all.length < 20_000);

  return all;
}

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

/**
 * Both reads before either lands in the store: handing the items over is what
 * draws the list, and a list drawn before the icons arrive would fill them in
 * a moment later, in front of the reader.
 */
async function loadAll(): Promise<void> {
  const [items] = await Promise.all([loadItems(), loadFavicons()]);
  store.setItems(items);
}

/**
 * The index is built in two stages: titles and excerpts first (the store has
 * them in memory, so search works immediately), then - on the full page only -
 * the content read from the database in batches. There is no reason for the
 * popup to pull in megabytes of content just to show 20 items.
 */
async function indexContents(): Promise<void> {
  const ids = await listContentIds();

  for (let offset = 0; offset < ids.length; offset += INDEX_BATCH) {
    const batch = await getContents(ids.slice(offset, offset + INDEX_BATCH));
    for (const content of batch) {
      store.setContentText(content.itemId, content.text);
    }
    // Yield to the browser so the list stays responsive.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  // A search that ran against titles alone now has the content to go on.
  if (store.query !== '') store.refresh();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let lastRange = { start: -1, end: -1 };

function render(force = false): void {
  const { scroller, sizer, rows, empty } = el;
  const { visible, selected } = store.view;

  const range = computeWindow({
    scrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
    total: visible.length,
    rowHeight,
    overscan: OVERSCAN,
  });

  sizer.style.height = `${String(range.totalHeight)}px`;
  empty.hidden = visible.length > 0;
  if (visible.length === 0) empty.textContent = store.emptyMessage();

  if (!force && range.start === lastRange.start && range.end === lastRange.end) return;
  lastRange = { start: range.start, end: range.end };

  const cards: HTMLLIElement[] = [];
  for (let position = range.start; position < range.end; position += 1) {
    const item = visible[position];
    if (item === undefined) continue;
    const card = createCard(item, position, callbacks, CARD_LAYOUT[MODE]);
    if (position === selected) card.setAttribute('aria-selected', 'true');
    applyFavicon(card, item);
    cards.push(card);
  }

  rows.replaceChildren(...cards);
  rows.style.transform = `translateY(${String(range.offsetY)}px)`;
}

function renderCounts(view: ListView): void {
  for (const tab of el.tabs) {
    const id = tab.dataset['tab'] as TabId | undefined;
    if (id === undefined) continue;
    tab.setAttribute('aria-selected', String(id === store.tab));
    const badge = tab.querySelector('.tab__count');
    if (badge !== null) badge.textContent = String(view.counts[id]);
  }

  el.footer.hidden = MODE === 'full' || view.matched <= view.visible.length;
  el.seeAll.textContent =
    view.matched > POPUP_LIMIT ? `See all (${String(view.matched)})` : 'See all';
}

function renderActiveTags(): void {
  el.activeTags.replaceChildren();
  el.activeTags.hidden = store.tags.length === 0;

  for (const tag of store.tags) {
    el.activeTags.append(
      tagChip(tag, {
        title: `Stop filtering by #${tag}`,
        removable: true,
        onClick: () => {
          store.removeTag(tag);
        },
      }),
    );
  }
}

/** The store changed something; everything the change could have touched redraws. */
function onViewChange(view: ListView): void {
  renderCounts(view);
  renderActiveTags();
  render(true);
}

// ---------------------------------------------------------------------------
// Site icons
// ---------------------------------------------------------------------------

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

function extensionUrl(path: string): string {
  return browser.runtime.getURL(path);
}

/** Always a new tab: the reader and the original must not swallow the list they came from. */
function openUrl(url: string): void {
  void browser.tabs.create({ url });
  if (MODE === 'popup') window.close();
}

/**
 * An item came back from the database changed. The store puts it on screen;
 * the announcement is for whoever else is showing it - the other list, the
 * reader open on this very item.
 */
function commit(updated: SavedItem): void {
  store.replace(updated);
  announceChange();
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
    void updateItem(item.id, { archived: !item.archived }).then(commit);
  },

  toggleFavorite(item) {
    void updateItem(item.id, { favorite: !item.favorite }).then(commit);
  },

  editTags(item, anchor) {
    openTagEditor({
      host: el.tagEditor,
      anchor,
      key: item.id,
      tags: item.tags,
      known: store.knownTags(),
      apply: (tags) => {
        void updateItem(item.id, { tags }).then(commit);
      },
    });
  },

  remove(item) {
    removeWithUndo(item);
  },

  filterByTag(tag) {
    store.addTag(tag);
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
  store.remove(item.id);

  const removed = deleteItem(item.id)
    .then((entry) => {
      announceChange();
      return entry;
    })
    .catch((error: unknown) => {
      // Nothing awaits this until Undo, and an unhandled rejection would take
      // the whole handler down with it.
      console.error('[savely] the deletion did not reach the database:', error);
      return null;
    });
  pending.set(item.id, { item, removed });

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
      pending.delete(item.id);
    },
  });
}

/** Puts the item back where it was, in the database first and then on screen. */
async function undoRemoval(id: string): Promise<void> {
  const entry = pending.get(id);
  if (entry === undefined) return;
  pending.delete(id);

  const removed = await entry.removed;
  if (removed !== null) await restoreItem(removed);

  store.restore(entry.item);
  announceChange();
}

// ---------------------------------------------------------------------------
// Selection and keyboard
// ---------------------------------------------------------------------------

function select(position: number): void {
  const scroller = el.scroller;
  if (scroller === null || store.view.visible.length === 0) return;

  const selected = store.select(position);

  const target = scrollTopFor(selected, scroller.scrollTop, scroller.clientHeight, rowHeight);
  if (target !== null) {
    scroller.scrollTop = target;
    render(true);
  }
  el.rows.querySelector<HTMLLIElement>('[aria-selected="true"]')?.focus();
}

function toggleHelp(): void {
  if (el.help.open) el.help.close();
  else el.help.showModal();
}

/**
 * What the search field does with what is in it: `tag:` tokens become filter
 * chips (`parseQuery`), the rest is searched for as words.
 *
 * `commitTrailing` is Enter - it finishes the token being typed, so a filter
 * can be applied without a trailing space.
 */
function applySearchInput(commitTrailing = false): void {
  const parsed = parseQuery(el.search.value, commitTrailing);
  // Only rewrite the field when something actually left it - otherwise the
  // caret would jump to the end on every keystroke.
  if (parsed.tags.length > 0) el.search.value = parsed.text;

  el.scroller.scrollTop = 0;
  store.applyQuery(parsed.query, parsed.tags);
}

function switchTab(tab: TabId): void {
  el.scroller.scrollTop = 0;
  store.setTab(tab);
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  if (event.key === 'Escape') {
    closeTagEditor();
    if (typing && target === el.search) {
      el.search.value = '';
      applySearchInput();
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

  const view = store.view;
  const item = store.selectedItem();

  switch (event.key) {
    case '/':
      event.preventDefault();
      el.search.focus();
      return;
    case '?':
      event.preventDefault();
      toggleHelp();
      return;
    case 'ArrowDown':
      event.preventDefault();
      select(view.selected + 1);
      return;
    case 'ArrowUp':
      event.preventDefault();
      select(view.selected - 1);
      return;
    case 'Home':
      event.preventDefault();
      select(0);
      return;
    case 'End':
      event.preventDefault();
      select(view.visible.length - 1);
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
      const anchor = el.rows.querySelector<HTMLElement>('[aria-selected="true"] .card__actions');
      if (anchor !== null) callbacks.editTags(item, anchor);
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
  el.status.textContent = message;
  el.status.dataset['tone'] = tone;
  el.status.hidden = false;
}

async function saveCurrentPage(): Promise<void> {
  el.save.disabled = true;
  showStatus('Saving…', 'ok');

  try {
    const response: unknown = await browser.runtime.sendMessage({ type: SAVE_ACTIVE_TAB });
    if (!isSaveResultMessage(response)) {
      showStatus('The background did not respond - please try again.', 'error');
      return;
    }
    showStatus(response.message, response.ok && !response.degraded ? 'ok' : 'error');
    // A save from a new site also brings a new icon.
    if (response.ok) await loadAll();
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

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  el.search.addEventListener('input', () => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applySearchInput();
    }, SEARCH_DEBOUNCE_MS);
  });

  // Enter turns the token being typed into a filter without waiting for the
  // space - and without waiting for the debounce either.
  el.search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    applySearchInput(true);
  });

  let frame = 0;
  el.scroller.addEventListener('scroll', () => {
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

  el.rows.addEventListener('click', (event) => {
    const card = (event.target as Element | null)?.closest<HTMLLIElement>('.card');
    const position = card?.dataset['index'];
    if (position !== undefined) select(Number(position));
  });

  el.seeAll.addEventListener('click', () => {
    openUrl(`${extensionUrl('ui/list/list.html')}?full=1`);
  });

  el.save.addEventListener('click', () => {
    void saveCurrentPage();
  });

  el.helpButton.addEventListener('click', toggleHelp);

  el.themeButton.addEventListener('click', cycleTheme);

  // On Firefox for Android about:addons is the only alternative - hence the
  // entry point to the options page from the list as well (CLAUDE.md 5.6).
  el.optionsButton.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  el.helpClose.addEventListener('click', () => {
    el.help.close();
  });

  document.addEventListener('keydown', onKeyDown);
}

async function main(): Promise<void> {
  wireEvents();
  store.subscribe(onViewChange);

  // A save from the toolbar, an article archived in the reader, an import on
  // the options page: whatever happened, this list is showing what it read at
  // startup until it reads again.
  onDataChanged(() => {
    void loadAll();
  });

  // Not awaited with the data: the theme is one storage read, and the list must
  // not wait for it - `initTheme` also keeps the page in step with the reader.
  void initTheme(showTheme);

  await loadAll();

  if (MODE === 'full') void indexContents();
}

void main();
