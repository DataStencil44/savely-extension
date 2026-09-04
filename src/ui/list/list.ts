/**
 * Lista zapisanych pozycji - ten sam plik obsługuje popup i pełną stronę
 * (`list.html?full=1`). Różnice trzymamy w jednym miejscu (`MODE` niżej):
 * popup ma sufit 600 px, pokazuje 20 ostatnich pozycji i kończy się
 * przyciskiem "Zobacz wszystkie".
 *
 * Wszystkie pozycje (bez treści) wchodzą do pamięci raz i tam są filtrowane -
 * metadane 5000 artykułów to kilka megabajtów, a każde przełączenie zakładki
 * czy tagu jest wtedy natychmiastowe. Treść czytamy tylko na żądanie:
 * do indeksu wyszukiwania i do miniatur.
 */
import browser from 'webextension-polyfill';

import {
  deleteItem,
  getContent,
  getContents,
  listContentIds,
  listItems,
  updateItem,
  type SavedItem,
} from '@/lib/db';
import { isSaveResultMessage } from '@/lib/guards';
import { SearchIndex } from '@/lib/search';
import { SAVE_ACTIVE_TAB } from '@/types/messages';

import { createCard, findLeadImage, type CardCallbacks } from './cards';
import { closeTagEditor, openTagEditor } from './tags';
import { flushToast, showToast } from './toast';
import { computeWindow, scrollTopFor } from './window';

type TabId = 'inbox' | 'favorite' | 'archive';

const OVERSCAN = 4;
const POPUP_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 150;
const UNDO_MS = 5_000;
/** Porcja tresci przy budowie indeksu - na tyle mala, zeby UI oddychal. */
const INDEX_BATCH = 150;

const MODE: 'popup' | 'full' =
  new URLSearchParams(location.search).get('full') === '1' ? 'full' : 'popup';

interface PendingDelete {
  item: SavedItem;
  timer: number;
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
 * Wysokość wiersza jest kontraktem między CSS a wirtualizacją, a przy 360 px
 * karta rośnie (akcje schodzą pod tagi). Dlatego wartość mieszka w CSS
 * (`--row-h`), a tutaj ją tylko odczytujemy - i ponownie po zmianie rozmiaru.
 */
function readRowHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 104;
}

let rowHeight = 104;

const index = new SearchIndex();
const thumbnails = new Map<string, string | null>();

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
};

// ---------------------------------------------------------------------------
// Dane
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
 * Indeks buduje się dwuetapowo: najpierw tytuły i zajawki (są w pamięci,
 * więc szukanie działa od razu), potem - tylko na pełnej stronie - treści
 * czytane z bazy porcjami. Popup nie ma po co wciągać megabajtów treści,
 * żeby pokazać 20 pozycji.
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
      if (!thumbnails.has(content.itemId)) {
        thumbnails.set(content.itemId, findLeadImage(content.html));
      }
    }
    // Oddajemy wątek przeglądarce, żeby lista pozostała responsywna.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  if (state.query !== '') recompute();
}

// ---------------------------------------------------------------------------
// Filtrowanie i render
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
    // Wyszukiwanie zawężamy do bieżącej zakładki - inaczej wynik z archiwum
    // pojawiałby się w skrzynce i odwrotnie.
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
        ? `Zobacz wszystkie (${String(filteredTotal)})`
        : 'Zobacz wszystkie';
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
    chip.title = `Przestań filtrować po #${tag}`;
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
    applyThumbnail(card, item.id);
    cards.push(card);
  }

  rows.replaceChildren(...cards);
  rows.style.transform = `translateY(${String(range.offsetY)}px)`;
  scheduleThumbnails();
}

function emptyMessage(): string {
  if (state.query.trim() !== '') return `Brak wyników dla „${state.query.trim()}”.`;
  if (state.tags.length > 0) return 'Żadna pozycja nie ma wszystkich wybranych tagów.';
  switch (state.tab) {
    case 'inbox':
      return 'Nic tu jeszcze nie ma. Zapisz pierwszą stronę.';
    case 'favorite':
      return 'Brak ulubionych.';
    case 'archive':
      return 'Archiwum jest puste.';
  }
}

// ---------------------------------------------------------------------------
// Miniatury
// ---------------------------------------------------------------------------

function applyThumbnail(card: HTMLLIElement, itemId: string): void {
  const source = thumbnails.get(itemId);
  if (source === undefined || source === null) return;
  const image = card.querySelector<HTMLImageElement>('.card__thumb');
  if (image === null) return;
  image.src = source;
  image.hidden = false;
}

let thumbnailTimer: number | undefined;

/**
 * Miniatury wyciągamy z zapisanej treści dopiero dla kart, które ktoś widzi -
 * i tylko raz na pozycję. Schemat bazy nie trzyma osobnego pola na obrazek,
 * więc alternatywą byłaby migracja; przy kilkunastu widocznych kartach jeden
 * odczyt z IndexedDB na kartę jest tańszy.
 */
function scheduleThumbnails(): void {
  if (thumbnailTimer !== undefined) clearTimeout(thumbnailTimer);
  thumbnailTimer = setTimeout(() => {
    void loadVisibleThumbnails();
  }, 120) as unknown as number;
}

async function loadVisibleThumbnails(): Promise<void> {
  const rows = el.rows;
  if (rows === null) return;

  for (const card of [...rows.children]) {
    if (!(card instanceof HTMLLIElement)) continue;
    const id = card.dataset['id'];
    if (id === undefined || thumbnails.has(id)) continue;

    const content = await getContent(id);
    thumbnails.set(id, content === undefined ? null : findLeadImage(content.html));
    applyThumbnail(card, id);
  }
}

// ---------------------------------------------------------------------------
// Akcje na pozycjach
// ---------------------------------------------------------------------------

function replaceItem(updated: SavedItem): void {
  state.items = state.items.map((item) => (item.id === updated.id ? updated : item));
  index.addItem({ id: updated.id, title: updated.title, excerpt: updated.excerpt });
  recompute();
}

function extensionUrl(path: string): string {
  return browser.runtime.getURL(path);
}

/** Zawsze nowa karta: czytnik i oryginał mają nie zjadać listy, z której wyszły. */
function openUrl(url: string): void {
  void browser.tabs.create({ url });
  if (MODE === 'popup') window.close();
}

const callbacks: CardCallbacks = {
  // Bez oznaczania jako przeczytane - o tym decyduje czytnik po dojściu do 90% treści.
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
 * Usunięcie jest natychmiastowe na ekranie, ale w bazie dopiero po 5 s.
 * Do tego czasu pozycja żyje w `state.pending` i da się ją cofnąć bez
 * dotykania IndexedDB.
 */
function removeWithUndo(item: SavedItem): void {
  if (el.toast === null) return;

  state.items = state.items.filter((entry) => entry.id !== item.id);
  index.remove(item.id);
  recompute();

  const timer = setTimeout(() => {
    state.pending.delete(item.id);
  }, UNDO_MS) as unknown as number;
  state.pending.set(item.id, { item, timer });

  showToast(el.toast, {
    message: `Usunięto „${item.title === '' ? item.url : item.title}”`,
    durationMs: UNDO_MS,
    action: {
      label: 'Cofnij',
      run: () => {
        const pending = state.pending.get(item.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        state.pending.delete(item.id);

        state.items = [...state.items, pending.item].sort((a, b) => b.savedAt - a.savedAt);
        index.addItem({ id: item.id, title: item.title, excerpt: item.excerpt });
        recompute();
      },
    },
    onExpire: () => {
      state.pending.delete(item.id);
      void deleteItem(item.id);
    },
  });
}

// ---------------------------------------------------------------------------
// Zaznaczenie i klawiatura
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
// Zapis z popupu
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
  showStatus('Zapisuję…', 'ok');

  try {
    const response: unknown = await browser.runtime.sendMessage({ type: SAVE_ACTIVE_TAB });
    if (!isSaveResultMessage(response)) {
      showStatus('Tło nie odpowiedziało - spróbuj jeszcze raz.', 'error');
      return;
    }
    showStatus(response.message, response.ok && !response.degraded ? 'ok' : 'error');
    if (response.ok) {
      await loadItems();
      indexMetadata();
      recompute();
    }
  } catch {
    showStatus('Nie udało się porozumieć z tłem rozszerzenia.', 'error');
  } finally {
    el.save.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Start
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

  // Na Firefoksie na Androidzie about:addons jest jedyna alternatywa - stad
  // wejscie do opcji takze z listy (CLAUDE.md 5.6).
  el.optionsButton?.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  document.querySelector('#help-close')?.addEventListener('click', () => {
    el.help?.close();
  });

  document.addEventListener('keydown', onKeyDown);

  // Zamknięcie okna nie może zawiesić usunięcia w połowie: domykamy toast,
  // co odpala właściwe `deleteItem`. Popup potrafi zniknąć szybciej, niż
  // transakcja dobiegnie końca - wtedy pozycja po prostu zostaje w bazie.
  window.addEventListener('pagehide', () => {
    if (el.toast !== null) flushToast(el.toast);
  });
}

async function main(): Promise<void> {
  wireEvents();

  await loadItems();
  indexMetadata();
  recompute();

  if (MODE === 'full') void indexContents();
}

void main();
