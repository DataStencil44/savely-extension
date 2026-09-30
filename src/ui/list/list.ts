import browser from 'webextension-polyfill';

import { onDataChanged } from '@/lib/changes';
import { faviconKey } from '@/lib/favicon';
import {
  getContents,
  listAllItems,
  listFavicons,
  toggleItem,
  updateItem,
  type SavedItem,
} from '@/lib/library';
import { sendMessage } from '@/lib/messaging';
import { DEFAULT_SETTINGS, type Theme } from '@/lib/settings';
import { THEME_ICONS, THEME_LABELS, initTheme, nextTheme, setTheme } from '@/lib/theme';
import { SAVE_ACTIVE_TAB } from '@/types/messages';
import { required } from '@/ui/shared/dom';

import { CARD_LAYOUT, createCard, type CardCallbacks } from './cards';
import { tagChip } from './chips';
import { bindingFor, type ItemCommand, type PageCommand } from './keys';
import { parseQuery } from './query';
import { createRemoval } from './removal';
import { ListStore, type ListView, type TabId } from './store';
import { closeTagEditor, openTagEditor } from './tags';
import { computeWindow, scrollTopFor } from './window';

const OVERSCAN = 4;
const POPUP_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 150;
const INDEX_BATCH = 150;

const MODE: 'popup' | 'full' =
  new URLSearchParams(location.search).get('full') === '1' ? 'full' : 'popup';

const store = new ListStore(MODE === 'popup' ? { limit: POPUP_LIMIT } : {});

function readRowHeight(): number {
  const raw = getComputedStyle(document.body).getPropertyValue('--row-h');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 104;
}

let rowHeight = 104;

let favicons = new Map<string, string>();

const el = {
  app: document.body,
  search: required<HTMLInputElement>('#search'),
  scroller: required<HTMLDivElement>('#scroller'),
  sizer: required<HTMLDivElement>('#sizer'),
  rows: required<HTMLUListElement>('#rows'),
  empty: required<HTMLParagraphElement>('#empty'),
  tabs: [...document.querySelectorAll<HTMLButtonElement>('.tab')],
  itemRead: required<HTMLButtonElement>('#item-read'),
  itemFavorite: required<HTMLButtonElement>('#item-favorite'),
  itemArchive: required<HTMLButtonElement>('#item-archive'),
  itemTags: required<HTMLButtonElement>('#item-tags'),
  itemDelete: required<HTMLButtonElement>('#item-delete'),
  itemTitle: required<HTMLSpanElement>('#item-title'),
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

async function loadFavicons(): Promise<void> {
  favicons = await listFavicons();
}

async function loadAll(): Promise<string[]> {
  const [items] = await Promise.all([listAllItems(), loadFavicons()]);
  return store.setItems(items);
}

async function reload(): Promise<void> {
  const stale = await loadAll();
  if (MODE === 'full' && stale.length > 0) await indexContents(stale);
}

async function indexContents(ids: readonly string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += INDEX_BATCH) {
    const batch = await getContents(ids.slice(offset, offset + INDEX_BATCH));
    for (const content of batch) {
      store.setContentText(content.itemId, content.text);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  if (store.query !== '') store.refresh();
}

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
    const card = createCard(item, position, cardCallbacks, CARD_LAYOUT[MODE]);
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

function setLabel(button: HTMLButtonElement, label: string): void {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function renderItemActions(): void {
  const item = store.selectedItem();

  for (const button of [el.itemRead, el.itemFavorite, el.itemArchive, el.itemTags, el.itemDelete]) {
    button.disabled = item === undefined;
  }

  const favorite = item?.favorite === true;
  el.itemFavorite.textContent = favorite ? '★' : '☆';
  el.itemFavorite.setAttribute('aria-pressed', String(favorite));
  setLabel(el.itemFavorite, favorite ? 'Remove from favorites (f)' : 'Add to favorites (f)');

  const archived = item?.archived === true;
  el.itemArchive.textContent = archived ? '↩' : '▤';
  el.itemArchive.setAttribute('aria-pressed', String(archived));
  setLabel(el.itemArchive, archived ? 'Restore from archive (a)' : 'Archive (a)');

  if (item === undefined) delete el.itemTags.dataset['tagsFor'];
  else el.itemTags.dataset['tagsFor'] = item.id;

  el.itemTitle.textContent = item === undefined ? '' : item.title === '' ? item.url : item.title;
}

function onViewChange(view: ListView): void {
  renderCounts(view);
  renderActiveTags();
  renderItemActions();
  render(true);
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

function extensionUrl(path: string): string {
  return browser.runtime.getURL(path);
}

function openUrl(url: string): void {
  void browser.tabs.create({ url });
  if (MODE === 'popup') window.close();
}

function commit(updated: SavedItem): void {
  store.replace(updated);
}

function openReader(item: SavedItem): void {
  openUrl(`${extensionUrl('ui/reader/index.html')}?id=${encodeURIComponent(item.id)}`);
}

function openOriginal(item: SavedItem): void {
  openUrl(item.resolvedUrl);
}

function toggleArchive(item: SavedItem): void {
  void toggleItem(item.id, 'archived').then(commit);
}

function toggleFavorite(item: SavedItem): void {
  void toggleItem(item.id, 'favorite').then(commit);
}

function editTags(item: SavedItem): void {
  openTagEditor({
    host: el.tagEditor,
    anchor: el.itemTags,
    key: item.id,
    tags: item.tags,
    known: store.knownTags(),
    apply: (tags) => {
      void updateItem(item.id, { tags }).then(commit);
    },
  });
}

const removeWithUndo = createRemoval(store, el.toast);

const cardCallbacks: CardCallbacks = {
  openOriginal,
  filterByTag(tag) {
    store.addTag(tag);
  },
};

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

function applySearchInput(commitTrailing = false): void {
  const parsed = parseQuery(el.search.value, commitTrailing);
  if (parsed.tags.length > 0) el.search.value = parsed.text;

  el.scroller.scrollTop = 0;
  store.applyQuery(parsed.query, parsed.tags);
}

function switchTab(tab: TabId): void {
  el.scroller.scrollTop = 0;
  store.setTab(tab);
}

function runPageCommand(command: PageCommand): void {
  const view = store.view;

  switch (command.kind) {
    case 'focus-search':
      el.search.focus();
      return;
    case 'toggle-help':
      toggleHelp();
      return;
    case 'select': {
      const positions = {
        next: view.selected + 1,
        previous: view.selected - 1,
        first: 0,
        last: view.visible.length - 1,
      };
      select(positions[command.to]);
      return;
    }
    case 'tab':
      switchTab(command.tab);
      return;
    case 'cycle-theme':
      cycleTheme();
      return;
  }
}

function runItemCommand(command: ItemCommand, item: SavedItem): void {
  switch (command) {
    case 'open-reader':
      openReader(item);
      return;
    case 'open-original':
      openOriginal(item);
      return;
    case 'toggle-archive':
      toggleArchive(item);
      return;
    case 'toggle-favorite':
      toggleFavorite(item);
      return;
    case 'edit-tags':
      editTags(item);
      return;
    case 'delete':
      removeWithUndo(item);
      return;
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeTagEditor();
    if (event.target === el.search) {
      el.search.value = '';
      applySearchInput();
      el.search.blur();
    }
    return;
  }

  const binding = bindingFor(event);
  if (binding === undefined) return;

  if (binding.scope === 'page') {
    if (binding.preventDefault) event.preventDefault();
    runPageCommand(binding.command);
    return;
  }

  const item = store.selectedItem();
  if (item === undefined) return;
  if (binding.preventDefault) event.preventDefault();
  runItemCommand(binding.command, item);
}

let theme: Theme = DEFAULT_SETTINGS.theme;

function showTheme(next: Theme): void {
  theme = next;

  const following = THEME_LABELS[nextTheme(next)];
  el.themeButton.textContent = THEME_ICONS[next];
  el.themeButton.title = `Theme: ${THEME_LABELS[next]} (switch to ${following})`;
  el.themeButton.setAttribute('aria-label', el.themeButton.title);
}

function cycleTheme(): void {
  const next = nextTheme(theme);
  showTheme(next);
  void setTheme(next);
}

function showStatus(message: string, tone: 'ok' | 'error'): void {
  el.status.textContent = message;
  el.status.dataset['tone'] = tone;
  el.status.hidden = false;
}

async function saveCurrentPage(): Promise<void> {
  el.save.disabled = true;
  showStatus('Saving…', 'ok');

  try {
    const response = await sendMessage({ type: SAVE_ACTIVE_TAB });
    if (response === null) {
      showStatus('The background did not respond - please try again.', 'error');
      return;
    }
    showStatus(response.message, response.ok && !response.degraded ? 'ok' : 'error');
    if (response.ok) await reload();
  } catch {
    showStatus('Could not reach the extension background.', 'error');
  } finally {
    el.save.disabled = false;
  }
}

function onItemAction(button: HTMLButtonElement, run: (item: SavedItem) => void): void {
  button.addEventListener('click', (event) => {
    if (event.detail > 1) return;
    const item = store.selectedItem();
    if (item !== undefined) run(item);
  });
}

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

  onItemAction(el.itemRead, openReader);
  onItemAction(el.itemFavorite, toggleFavorite);
  onItemAction(el.itemArchive, toggleArchive);
  onItemAction(el.itemTags, editTags);
  onItemAction(el.itemDelete, removeWithUndo);

  el.seeAll.addEventListener('click', () => {
    openUrl(`${extensionUrl('ui/list/list.html')}?full=1`);
  });

  el.save.addEventListener('click', () => {
    void saveCurrentPage();
  });

  el.helpButton.addEventListener('click', toggleHelp);

  el.themeButton.addEventListener('click', cycleTheme);

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

  onDataChanged(() => {
    void reload();
  });

  void initTheme(showTheme);

  await reload();
}

void main();
