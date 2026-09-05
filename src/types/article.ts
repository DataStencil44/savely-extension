/**
 * The extraction result contract - shared by both save paths:
 * the content script in the tab (A) and background fetch + parse (B).
 */

export interface ExtractedArticle {
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  /** HTML after Readability and after DOMPurify - ready to store. */
  html: string;
  /** The same content as plain text (the source for wordCount and search). */
  text: string;
  wordCount: number;
  estReadingMinutes: number;
  /** The address links and images were resolved against. */
  resolvedUrl: string;
}

/** Why the full content could not be extracted. */
export type ExtractProblem =
  /** The document is not HTML (a PDF, an image, a plugin). Not saved. */
  | 'unsupported-document'
  /** The page is empty or unreachable. Not saved. */
  | 'empty-document'
  /** Readability returned nothing - we store the entry alone (status 'failed'). */
  | 'no-article';

/** The minimum that still lands in the list when Readability gives up. */
export interface ArticleStub {
  title: string;
  /** Usually `og:description` or `meta[name=description]`. */
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
