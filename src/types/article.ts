export interface ExtractedArticle {
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  html: string;
  text: string;
  wordCount: number;
  estReadingMinutes: number;
  resolvedUrl: string;
  faviconUrls: string[];
}

export type ExtractProblem =
  | 'unsupported-document'
  | 'empty-document'
  | 'no-article';

export interface ArticleStub {
  title: string;
  excerpt: string;
  siteName: string | null;
  lang: string | null;
  resolvedUrl: string;
  faviconUrls: string[];
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
