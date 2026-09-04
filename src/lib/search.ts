/**
 * Indeks wyszukiwania pelnotekstowego (FlexSearch).
 *
 * Indeks jest **pochodna bazy** (CLAUDE.md 4.4): budowany przy starcie UI
 * z IndexedDB i aktualizowany przyrostowo. Jego utrata to przebudowa,
 * nigdy utrata danych.
 *
 * Modul nie dotyka ani bazy, ani DOM-u - dostaje pola, oddaje identyfikatory.
 */
// Build ESM flexsearcha wystawia tylko domyslny eksport (obiekt z klasami),
// mimo ze @types deklaruje eksporty nazwane - stad import wartosci osobno
// od importu typu.
import FlexSearch from 'flexsearch';
import type { Document as FlexDocument } from 'flexsearch';

interface SearchDoc {
  id: string;
  title: string;
  excerpt: string;
  text: string;
}

/** Ile znakow tresci trafia do indeksu. Dalej to juz same powtorzenia. */
const MAX_INDEXED_CHARS = 30_000;

/** Waga pola w wyniku - trafienie w tytul znaczy wiecej niz w srodku tekstu. */
const FIELD_WEIGHT: Record<string, number> = { title: 4, excerpt: 2, text: 1 };

/**
 * Tokenizer swiadomy polskich znakow: FlexSearch-owy `simple` sprowadza
 * tylko zachodnie diakrytyki, wiec "wyborczą" nie trafiloby w "wyborcza".
 * NFD rozklada ogonki i kreski na znaki laczace, ktore tu odsiewamy;
 * "ł" nie ma rozkladu, stad osobna podmiana.
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
   * FlexSearch nie pozwala dopisac pojedynczego pola do istniejacego
   * dokumentu, wiec trzymamy obok komplet pol i podmieniamy caly dokument,
   * gdy dojdzie tresc.
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

  /** Metadane pozycji. Tresc dochodzi pozniej przez `setText`. */
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
   * Identyfikatory posortowane malejaco po trafnosci: suma wag pol, w ktorych
   * zapytanie trafilo, z premia za wczesniejsza pozycje w wynikach pola.
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
