/**
 * What the list is showing, and why - with no DOM in sight.
 *
 * The page used to keep this in module-level variables next to the rendering,
 * which made two things awkward. The items and the search index had to be kept
 * in step by hand at every call site - an item that changed had to be
 * re-indexed, a deleted one dropped from the index - which is four places that
 * could each forget. And nothing about the filtering could be tested without
 * building a document first, so the rules for what a tab holds, or what a
 * search does to the order, were only ever checked through the DOM they
 * happened to produce.
 *
 * So the store owns both collections and every change goes through it: the
 * index cannot fall behind the items, because the same method moves them.
 * Everything here is plain data - the page subscribes, and draws.
 */
import type { SavedItem } from '@/lib/db';
import { SearchIndex } from '@/lib/search';

export type TabId = 'inbox' | 'favorite' | 'archive';

/**
 * How deep a search reaches. Far past a screen, well short of a corpus: the
 * ranking beyond a few hundred hits is not what anyone is scrolling for.
 */
const SEARCH_LIMIT = 500;

export interface ListView {
  /** The items to draw, in order - already cut to `limit`. */
  visible: readonly SavedItem[];
  /** How many items pass the filters, before that cut. */
  matched: number;
  /** The tab badges. Counted over everything, so they hold still while you filter. */
  counts: Record<TabId, number>;
  /** The index into `visible`, or -1 for nothing selected. */
  selected: number;
}

export interface ListStoreOptions {
  /** The popup draws the top of the list only. Left out: all of it. */
  limit?: number;
}

const EMPTY_VIEW: ListView = {
  visible: [],
  matched: 0,
  counts: { inbox: 0, favorite: 0, archive: 0 },
  selected: -1,
};

export class ListStore {
  readonly #index = new SearchIndex();
  readonly #limit: number;
  readonly #listeners = new Set<(view: ListView) => void>();

  #items: SavedItem[] = [];
  #tab: TabId = 'inbox';
  #query = '';
  #tags: string[] = [];
  #selected = -1;
  #view: ListView = EMPTY_VIEW;

  constructor(options: ListStoreOptions = {}) {
    this.#limit = options.limit ?? Number.POSITIVE_INFINITY;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get view(): ListView {
    return this.#view;
  }

  get tab(): TabId {
    return this.#tab;
  }

  get query(): string {
    return this.#query;
  }

  get tags(): readonly string[] {
    return this.#tags;
  }

  get items(): readonly SavedItem[] {
    return this.#items;
  }

  selectedItem(): SavedItem | undefined {
    return this.#view.visible[this.#selected];
  }

  /** Every tag in use, for the tag editor's suggestions. */
  knownTags(): string[] {
    const all = new Set<string>();
    for (const item of this.#items) for (const tag of item.tags) all.add(tag);
    return [...all].sort();
  }

  /**
   * Why the list is empty - which is never just one reason. A filter that found
   * nothing and a tab that holds nothing look identical on screen, and the
   * difference is the whole of what the reader needs to know.
   */
  emptyMessage(): string {
    if (this.#query.trim() !== '') return `No results for “${this.#query.trim()}”.`;
    if (this.#tags.length > 0) return 'No item has all of the selected tags.';
    switch (this.#tab) {
      case 'inbox':
        return 'Nothing here yet. Save your first page.';
      case 'favorite':
        return 'No favorites.';
      case 'archive':
        return 'The archive is empty.';
    }
  }

  /** Called after every change, with the view to draw. */
  subscribe(listener: (view: ListView) => void): void {
    this.#listeners.add(listener);
  }

  // -------------------------------------------------------------------------
  // The items
  // -------------------------------------------------------------------------

  /** A fresh read of the database. The metadata index is rebuilt with it. */
  setItems(items: readonly SavedItem[]): void {
    this.#items = [...items];
    this.#index.clear();
    for (const item of this.#items) this.#addToIndex(item);
    this.#recompute();
  }

  /**
   * An item's content, once it has been read - the full page only. It changes
   * what a search can find, not what is on screen, so it draws nothing; when a
   * search is already running, `refresh` re-runs it against the fuller index.
   */
  setContentText(id: string, text: string): void {
    this.#index.setText(id, text);
  }

  /** The view again, on unchanged filters - for when the index grew underneath it. */
  refresh(): void {
    this.#recompute();
  }

  /** An item came back changed from the database: archived, tagged, favorited. */
  replace(updated: SavedItem): void {
    this.#items = this.#items.map((item) => (item.id === updated.id ? updated : item));
    this.#addToIndex(updated);
    this.#recompute();
  }

  /** Off the screen. The database is the caller's business; the index is not. */
  remove(id: string): void {
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#index.remove(id);
    this.#recompute();
  }

  /** Back on screen, in its place by date - Undo, and nothing else. */
  restore(item: SavedItem): void {
    this.#items = [...this.#items, item].sort((a, b) => b.savedAt - a.savedAt);
    this.#addToIndex(item);
    this.#recompute();
  }

  // -------------------------------------------------------------------------
  // The filters
  // -------------------------------------------------------------------------

  setTab(tab: TabId): void {
    this.#tab = tab;
    this.#selected = -1;
    this.#recompute();
  }

  /**
   * What the search field means: the words to search for, plus any `tag:`
   * tokens that have turned into filters (`parseQuery`). One call, because
   * they arrive from one keystroke and would otherwise redraw the list twice.
   */
  applyQuery(query: string, tags: readonly string[] = []): void {
    for (const tag of tags) if (!this.#tags.includes(tag)) this.#tags = [...this.#tags, tag];
    this.#query = query;
    this.#selected = -1;
    this.#recompute();
  }

  /** A tag clicked on a card. The selection stays where it is. */
  addTag(tag: string): void {
    if (this.#tags.includes(tag)) return;
    this.#tags = [...this.#tags, tag];
    this.#recompute();
  }

  removeTag(tag: string): void {
    this.#tags = this.#tags.filter((value) => value !== tag);
    this.#recompute();
  }

  // -------------------------------------------------------------------------
  // The selection
  // -------------------------------------------------------------------------

  /** Moves the selection, clamped to the list. Answers with where it landed. */
  select(position: number): number {
    if (this.#view.visible.length === 0) return this.#selected;
    this.#selected = Math.min(Math.max(position, 0), this.#view.visible.length - 1);
    this.#view = { ...this.#view, selected: this.#selected };
    this.#notify();
    return this.#selected;
  }

  // -------------------------------------------------------------------------
  // Deriving the view
  // -------------------------------------------------------------------------

  #addToIndex(item: SavedItem): void {
    this.#index.addItem({ id: item.id, title: item.title, excerpt: item.excerpt });
  }

  #matchesTab(item: SavedItem): boolean {
    switch (this.#tab) {
      case 'inbox':
        return !item.archived;
      case 'favorite':
        return item.favorite;
      case 'archive':
        return item.archived;
    }
  }

  #matchesTags(item: SavedItem): boolean {
    return this.#tags.every((tag) => item.tags.includes(tag));
  }

  #recompute(): void {
    const base = this.#items.filter((item) => this.#matchesTab(item) && this.#matchesTags(item));

    let matched = base;
    if (this.#query.trim() !== '') {
      // The search is scoped to the tab in view - otherwise an archived hit
      // would surface in the inbox, and the other way round.
      const ranking = new Map(
        this.#index.search(this.#query, SEARCH_LIMIT).map((id, position) => [id, position]),
      );
      matched = base
        .filter((item) => ranking.has(item.id))
        .sort((a, b) => (ranking.get(a.id) ?? 0) - (ranking.get(b.id) ?? 0));
    }

    const visible = matched.length > this.#limit ? matched.slice(0, this.#limit) : matched;
    this.#selected = Math.min(this.#selected, visible.length - 1);

    this.#view = {
      visible,
      matched: matched.length,
      counts: {
        inbox: this.#items.filter((item) => !item.archived).length,
        favorite: this.#items.filter((item) => item.favorite).length,
        archive: this.#items.filter((item) => item.archived).length,
      },
      selected: this.#selected,
    };

    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#view);
  }
}
