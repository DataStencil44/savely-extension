/**
 * Saving an article - two paths, one shared tail.
 *
 * A) `savePageInTab` - the page is open: the content script reads the live DOM.
 *    It sidesteps CORS and sees content behind a login, because it reads
 *    exactly what the user sees.
 * B) `saveLinkInBackground` - saving a link nobody opened: a background `fetch`
 *    plus parsing outside the tab. Requires host permission.
 *
 * Each path is **one awaited sequence**, with no state in module variables:
 * when Chrome kills the service worker halfway, nothing of ours is left except
 * what is already in IndexedDB (CLAUDE.md 5.5).
 */
import browser from 'webextension-polyfill';

import { saveItem, setContent } from './db';
import { isOutcomeResponse } from './guards';
import { extractHtmlOutOfBand } from './offscreen';
import { checkPageUrl } from './page-url';
import { requestHostAccess } from './permissions';
import { EXTRACT_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

export interface SaveResult {
  ok: boolean;
  /** A message ready to show the user. */
  message: string;
  /** The save succeeded but without article content (the entry has status 'failed'). */
  degraded: boolean;
  itemId: string | null;
}

function fail(message: string): SaveResult {
  return { ok: false, message, degraded: false, itemId: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The shared tail of both paths: extraction result -> database.
 *
 * `requestUrl` is the address the user was saving; the `resolvedUrl` from the
 * result may differ (a redirect) and it is the one deduplication goes by.
 */
async function persist(outcome: ExtractOutcome, requestUrl: string): Promise<SaveResult> {
  if (outcome.kind === 'refused') {
    return fail(outcome.message);
  }

  if (outcome.kind === 'stub') {
    const { stub } = outcome;
    const item = await saveItem({
      url: requestUrl,
      resolvedUrl: stub.resolvedUrl,
      title: stub.title,
      excerpt: stub.excerpt,
      siteName: stub.siteName,
      lang: stub.lang,
      status: 'failed',
    });

    return {
      ok: true,
      degraded: true,
      itemId: item.id,
      message: `Saved the entry only: ${stub.title}. The content could not be extracted.`,
    };
  }

  const { article } = outcome;

  // The entry first (status 'pending'), then the content - `setContent` flips
  // the item to 'ready' in the same transaction. If the worker dies between
  // those steps, the list keeps an entry in 'pending', not half the data.
  const item = await saveItem({
    url: requestUrl,
    resolvedUrl: article.resolvedUrl,
    title: article.title,
    excerpt: article.excerpt,
    byline: article.byline,
    siteName: article.siteName,
    lang: article.lang,
    wordCount: article.wordCount,
    estReadingMinutes: article.estReadingMinutes,
    status: 'pending',
  });

  await setContent(item.id, {
    html: article.html,
    text: article.text,
    contentHash: await sha256Hex(article.text),
  });

  return {
    ok: true,
    degraded: false,
    itemId: item.id,
    message: `Saved: ${article.title}`,
  };
}

/** Path A: the page is open in a tab. */
export async function savePageInTab(tabId: number, url: string): Promise<SaveResult> {
  const problem = checkPageUrl(url);
  if (problem !== null) return fail(problem);

  let outcome: ExtractOutcome;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const response: unknown = await browser.tabs.sendMessage(tabId, { type: EXTRACT_REQUEST });
    if (!isOutcomeResponse(response)) {
      return fail('The tab answered with something I do not understand - try refreshing the page.');
    }
    outcome = response.outcome;
  } catch (error) {
    return fail(
      `I cannot read this tab (${errorMessage(error)}). Browser-internal pages, the add-on store and PDFs are out of reach.`,
    );
  }

  return persist(outcome, url);
}

/**
 * Path B: a link from the context menu, the page not open.
 *
 * `requestHostAccess` is the first `await` - in Firefox the permission request
 * has to come straight from a user gesture or it is rejected.
 */
export async function saveLinkInBackground(url: string): Promise<SaveResult> {
  const problem = checkPageUrl(url);
  if (problem !== null) return fail(problem);

  const granted = await requestHostAccess(url);
  if (!granted) {
    return fail(
      'Without permission for this host I cannot fetch the content. On the first save from a site that is normal - click again and confirm the request.',
    );
  }

  let response: Response;
  try {
    // `credentials: 'omit'` - saving a link has no right to use the user's
    // cookies. Content behind a login is saved via path A, from an open tab.
    response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  } catch (error) {
    return fail(`Could not fetch the page (${errorMessage(error)}).`);
  }

  if (!response.ok) {
    return fail(`The server answered ${String(response.status)} - there is nothing to save.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return fail(
      `This address is not an HTML page (${contentType === '' ? 'unknown type' : contentType}).`,
    );
  }

  const html = await response.text();

  try {
    const outcome = await extractHtmlOutOfBand(html, response.url === '' ? url : response.url);
    return await persist(outcome, url);
  } catch (error) {
    return fail(`Could not process the page (${errorMessage(error)}).`);
  }
}
