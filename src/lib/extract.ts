/**
 * Extracting an article from a document.
 *
 * This module runs anywhere there is a DOM: in the content script (path A), in
 * the offscreen document on Chromium and on Firefox's background page (path B).
 * It touches no browser API - it takes a `Document` and returns a result.
 */
import { Readability } from '@mozilla/readability';

import { findFaviconUrl } from './favicon';
import { sanitizeArticleHtml } from './sanitize';
import { estimateReadingMinutes, type ExtractOutcome } from '@/types/article';

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Below this many characters we treat the content as absent.
 *
 * On an SPA shell Readability can return the navigation bar alone and present
 * it as the article. Better then to store an entry with `og:description` than
 * to pretend we have content. The cost: a very short note also ends up as an
 * entry without content.
 */
const MIN_ARTICLE_CHARS = 140;

function metaContent(doc: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    const content = element?.getAttribute('content')?.trim();
    if (content !== undefined && content !== '') return content;
  }
  return null;
}

function readTitle(doc: Document): string {
  const meta = metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']);
  const title = meta ?? doc.title.trim();
  return title === '' ? 'Untitled' : title;
}

function readDescription(doc: Document): string {
  return (
    metaContent(doc, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ]) ?? ''
  );
}

function readSiteName(doc: Document): string | null {
  return metaContent(doc, ['meta[property="og:site_name"]']);
}

function readLang(doc: Document): string | null {
  const lang = doc.documentElement.getAttribute('lang')?.trim();
  return lang === undefined || lang === '' ? null : lang;
}

/**
 * Extracts the content from a ready document.
 *
 * Readability rearranges and removes nodes, so it always gets a **clone** -
 * otherwise path A would wreck the page the user has open.
 */
export function extractFromDocument(doc: Document, resolvedUrl: string): ExtractOutcome {
  const contentType = doc.contentType.toLowerCase();
  if (!HTML_CONTENT_TYPES.includes(contentType)) {
    return {
      kind: 'refused',
      problem: 'unsupported-document',
      message:
        contentType === 'application/pdf'
          ? 'This is a PDF, not an HTML page - Savely has nothing to build an article from.'
          : `Savely saves HTML pages, and this document is ${contentType}.`,
    };
  }

  if (doc.body === null || doc.body.textContent?.trim() === '') {
    return {
      kind: 'refused',
      problem: 'empty-document',
      message: 'The page is empty - there is nothing to save.',
    };
  }

  const stub = {
    title: readTitle(doc),
    excerpt: readDescription(doc),
    siteName: readSiteName(doc),
    lang: readLang(doc),
    resolvedUrl,
    // The address only - reading the DOM must stay synchronous and free of
    // network access; whoever can reach the site fetches the bytes.
    faviconUrl: findFaviconUrl(doc, resolvedUrl),
  };

  let parsed: ReturnType<Readability['parse']> = null;
  try {
    parsed = new Readability(doc.cloneNode(true) as Document).parse();
  } catch {
    // Readability can blow up on an exotic DOM. That is no reason to lose the
    // save - we fall back to an entry without content.
    parsed = null;
  }

  if (parsed === null) {
    return { kind: 'stub', problem: 'no-article', stub };
  }

  const content = parsed.content ?? '';
  if (content.trim() === '') {
    return { kind: 'stub', problem: 'no-article', stub };
  }

  const clean = sanitizeArticleHtml(content, resolvedUrl);
  if (clean.text.length < MIN_ARTICLE_CHARS) {
    return { kind: 'stub', problem: 'no-article', stub };
  }

  const title = parsed.title?.trim();
  const excerpt = parsed.excerpt?.trim();
  const siteName = parsed.siteName?.trim();
  const byline = parsed.byline?.trim();

  return {
    kind: 'article',
    article: {
      title: title === undefined || title === '' ? stub.title : title,
      excerpt: excerpt === undefined || excerpt === '' ? stub.excerpt : excerpt,
      byline: byline === undefined || byline === '' ? null : byline,
      siteName: siteName === undefined || siteName === '' ? stub.siteName : siteName,
      lang: parsed.lang ?? stub.lang,
      html: clean.html,
      text: clean.text,
      wordCount: clean.wordCount,
      estReadingMinutes: estimateReadingMinutes(clean.wordCount),
      resolvedUrl,
      faviconUrl: stub.faviconUrl,
    },
  };
}

/**
 * The variant for path B: HTML pulled in with `fetch`, with no live tab.
 * The `<base>` element has to reach the document before Readability starts
 * resolving addresses - a DOMParser document inherits its baseURI from the
 * extension page.
 */
export function extractFromHtml(html: string, resolvedUrl: string): ExtractOutcome {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const base = doc.createElement('base');
  base.setAttribute('href', resolvedUrl);
  doc.head.prepend(base);

  return extractFromDocument(doc, resolvedUrl);
}
