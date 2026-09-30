import type { SavedItem } from '@/types/item';
import { SearchIndex } from '@/lib/search';

export type TabId = 'inbox' | 'favorite' | 'archive';

const SEARCH_LIMIT = 500;

export interface ListView {
  visible: readonly SavedItem[];
  matched: number;
  counts: Record<TabId, number>;
  selected: number;
}

export interface ListStoreOptions {
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

  knownTags(): string[] {
    const all = new Set<string>();
    for (const item of this.#items) for (const tag of item.tags) all.add(tag);
    return [...all].sort();
  }

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

  subscribe(listener: (view: ListView) => void): void {
    this.#listeners.add(listener);
  }

  setItems(items: readonly SavedItem[]): string[] {
    const previous = new Map(this.#items.map((item) => [item.id, item]));
    const stale: string[] = [];

    for (const item of items) {
      const before = previous.get(item.id);
      previous.delete(item.id);

      if (before?.contentHash !== item.contentHash) stale.push(item.id);
      if (before?.title !== item.title || before.excerpt !== item.excerpt) {
        this.#addToIndex(item);
      }
    }
    for (const id of previous.keys()) this.#index.remove(id);

    this.#items = [...items];
    this.#recompute();
    return stale;
  }

  setContentText(id: string, text: string): void {
    this.#index.setText(id, text);
  }

  refresh(): void {
    this.#recompute();
  }

  replace(updated: SavedItem): void {
    this.#items = this.#items.map((item) => (item.id === updated.id ? updated : item));
    this.#addToIndex(updated);
    this.#recompute();
  }

  remove(id: string): void {
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#index.remove(id);
    this.#recompute();
  }

  restore(item: SavedItem): void {
    this.#items = [...this.#items, item].sort((a, b) => b.savedAt - a.savedAt);
    this.#addToIndex(item);
    this.#recompute();
  }

  setTab(tab: TabId): void {
    this.#tab = tab;
    this.#selected = -1;
    this.#recompute();
  }

  applyQuery(query: string, tags: readonly string[] = []): void {
    for (const tag of tags) if (!this.#tags.includes(tag)) this.#tags = [...this.#tags, tag];
    this.#query = query;
    this.#selected = -1;
    this.#recompute();
  }

  addTag(tag: string): void {
    if (this.#tags.includes(tag)) return;
    this.#tags = [...this.#tags, tag];
    this.#recompute();
  }

  removeTag(tag: string): void {
    this.#tags = this.#tags.filter((value) => value !== tag);
    this.#recompute();
  }

  select(position: number): number {
    if (this.#view.visible.length === 0) return this.#selected;
    this.#selected = Math.min(Math.max(position, 0), this.#view.visible.length - 1);
    this.#view = { ...this.#view, selected: this.#selected };
    this.#notify();
    return this.#selected;
  }

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
