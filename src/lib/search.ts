/**
 * The full-text search index (FlexSearch).
 *
 * The index is **derived from the database** (CLAUDE.md 4.4): built at UI
 * startup from IndexedDB and updated incrementally. Losing it means a rebuild,
 * never a loss of data.
 *
 * The module touches neither the database nor the DOM - it takes fields and
 * returns identifiers.
 */
// The ESM build of flexsearch exposes only a default export (an object of
// classes), even though @types declares named exports - hence the value import
// separate from the type import.
import FlexSearch from 'flexsearch';
import type { Document as FlexDocument } from 'flexsearch';

interface SearchDoc {
  id: string;
  title: string;
  excerpt: string;
  text: string;
}

/** How many characters of content reach the index. Beyond that it is repetition. */
const MAX_INDEXED_CHARS = 30_000;

/** A field's weight in the score - a hit in the title counts more than one mid-text. */
const FIELD_WEIGHT: Record<string, number> = { title: 4, excerpt: 2, text: 1 };

/**
 * A diacritics-aware tokenizer: FlexSearch's `simple` folds only Western
 * diacritics, so "wyborcz\u0105" would not match "wyborcza". NFD decomposes
 * accents into combining marks, which we strip here; "\u0142" has no
 * decomposition, hence the separate replacement.
 */
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
  /**
   * FlexSearch does not allow appending a single field to an existing
   * document, so we keep the complete set of fields alongside and swap the
   * whole document once the content arrives.
   */
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

  /** An item's metadata. The content arrives later through `setText`. */
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

  /**
   * Identifiers sorted by descending relevance: the sum of the weights of the
   * fields the query hit, with a bonus for an earlier position within a
   * field's results.
   */
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
