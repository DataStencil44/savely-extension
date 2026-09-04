/**
 * Kontrakt wyniku ekstrakcji - wspolny dla obu sciezek zapisu:
 * content script w karcie (A) i fetch + parsowanie w tle (B).
 */

export interface ExtractedArticle {
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  /** HTML po Readability i po DOMPurify - gotowy do zapisu. */
  html: string;
  /** Ta sama tresc jako czysty tekst (zrodlo dla wordCount i wyszukiwarki). */
  text: string;
  wordCount: number;
  estReadingMinutes: number;
  /** Adres, wzgledem ktorego rozwiazano linki i obrazki. */
  resolvedUrl: string;
}

/** Dlaczego nie udalo sie wyciagnac pelnej tresci. */
export type ExtractProblem =
  /** Dokument nie jest HTML-em (PDF, obrazek, plugin). Nie zapisujemy. */
  | 'unsupported-document'
  /** Strona jest pusta albo niedostepna. Nie zapisujemy. */
  | 'empty-document'
  /** Readability nic nie zwrocil - zapisujemy sam wpis (status 'failed'). */
  | 'no-article';

/** Minimum, ktore i tak trafia na liste, gdy Readability polegnie. */
export interface ArticleStub {
  title: string;
  /** Zwykle `og:description` albo `meta[name=description]`. */
  excerpt: string;
  siteName: string | null;
  lang: string | null;
  resolvedUrl: string;
}

export type ExtractOutcome =
  | { kind: 'article'; article: ExtractedArticle }
  | { kind: 'stub'; problem: ExtractProblem; stub: ArticleStub }
  | { kind: 'refused'; problem: ExtractProblem; message: string };

export const WORDS_PER_MINUTE = 200;

export function estimateReadingMinutes(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}
