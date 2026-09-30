import browser from 'webextension-polyfill';

import { announceChange } from './changes';
import { saveItem, setContent, putFavicon } from './db';
import { captureFavicon, faviconKey, faviconUrlsOf } from './favicon';
import { sendToTab } from './messaging';
import { extractHtmlOutOfBand } from './offscreen';
import { checkPageUrl } from './page-url';
import { requestHostAccess } from './permissions';
import { errorMessage } from './unknown';
import { EXTRACT_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

export interface SaveResult {
  ok: boolean;
  message: string;
  degraded: boolean;
  itemId: string | null;
}

function fail(message: string): SaveResult {
  return { ok: false, message, degraded: false, itemId: null };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function storeFavicon(pageUrl: string, dataUrl: string | null): Promise<void> {
  if (dataUrl === null) return;
  const domain = faviconKey(pageUrl);
  if (domain === null) return;
  try {
    await putFavicon(domain, dataUrl);
  } catch {
    // ignore
  }
}

async function persist(
  outcome: ExtractOutcome,
  requestUrl: string,
  favicon: string | null,
): Promise<SaveResult> {
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

    await storeFavicon(stub.resolvedUrl, favicon);
    announceChange();

    return {
      ok: true,
      degraded: true,
      itemId: item.id,
      message: `Saved the entry only: ${stub.title}. The content could not be extracted.`,
    };
  }

  const { article } = outcome;

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

  await storeFavicon(article.resolvedUrl, favicon);
  announceChange();

  return {
    ok: true,
    degraded: false,
    itemId: item.id,
    message: `Saved: ${article.title}`,
  };
}

export async function savePageInTab(tabId: number, url: string): Promise<SaveResult> {
  const problem = checkPageUrl(url);
  if (problem !== null) return fail(problem);

  let outcome: ExtractOutcome;
  let favicon: string | null = null;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const response = await sendToTab(tabId, { type: EXTRACT_REQUEST });
    if (response === null) {
      return fail('The tab answered with something I do not understand - try refreshing the page.');
    }
    outcome = response.outcome;
    favicon = response.favicon ?? null;
  } catch (error) {
    return fail(
      `I cannot read this tab (${errorMessage(error)}). Browser-internal pages, the add-on store and PDFs are out of reach.`,
    );
  }

  return persist(outcome, url, favicon);
}

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
    const favicon = await captureFavicon(faviconUrlsOf(outcome));
    return await persist(outcome, url, favicon);
  } catch (error) {
    return fail(`Could not process the page (${errorMessage(error)}).`);
  }
}
