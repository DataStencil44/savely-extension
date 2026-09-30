import FlexSearch from 'flexsearch';
import type { Document as FlexDocument } from 'flexsearch';

interface SearchDoc {
  id: string;
  title: string;
  excerpt: string;
  text: string;
}

const MAX_INDEXED_CHARS = 30_000;

const FIELD_WEIGHT: Record<string, number> = { title: 4, excerpt: 2, text: 1 };

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

export interface IndexableItem {
  id: string;
  title: string;
  excerpt: string;
}

export class SearchIndex {
  readonly #docs = new Map<string, SearchDoc>();

  #index = SearchIndex.#createIndex();

  static #createIndex(): FlexDocument<SearchDoc> {
    return new FlexSearch.Document<SearchDoc>({
      document: { id: 'id', index: ['title', 'excerpt', 'text'] },
      tokenize: 'forward',
      encode: tokenize,
    });
  }

  get size(): number {
    return this.#docs.size;
  }

  addItem(item: IndexableItem): void {
    const existing = this.#docs.get(item.id);
    this.#put({
      id: item.id,
      title: item.title,
      excerpt: item.excerpt,
      text: existing?.text ?? '',
    });
  }

  setText(id: string, text: string): void {
    const existing = this.#docs.get(id);
    if (existing === undefined) return;
    this.#put({ ...existing, text: text.slice(0, MAX_INDEXED_CHARS) });
  }

  remove(id: string): void {
    if (!this.#docs.delete(id)) return;
    this.#index.remove(id);
  }

  clear(): void {
    this.#docs.clear();
    this.#index = SearchIndex.#createIndex();
  }

  search(query: string, limit = 200): string[] {
    if (query.trim() === '') return [];

    const scores = new Map<string, number>();
    for (const group of this.#index.search(query, { limit, index: ['title', 'excerpt', 'text'] })) {
      const weight = FIELD_WEIGHT[String(group.field)] ?? 1;
      group.result.forEach((id, position) => {
        const key = String(id);
        scores.set(key, (scores.get(key) ?? 0) + weight + 1 / (position + 1));
      });
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  #put(doc: SearchDoc): void {
    if (this.#docs.has(doc.id)) this.#index.remove(doc.id);
    this.#docs.set(doc.id, doc);
    this.#index.add(doc);
  }
}
