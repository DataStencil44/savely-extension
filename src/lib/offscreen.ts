/**
 * Parsing HTML fetched in the background (path B), whatever the engine.
 *
 * Firefox: the background page has a DOM, so `DOMParser` is right there.
 * Chromium: the service worker has no DOM - the HTML travels to an offscreen
 * document that exists only for the duration of one parse.
 *
 * This is the only place in `src/` with `chrome.*`: the `offscreen` API exists
 * neither in Firefox nor in webextension-polyfill (an allowed exception,
 * CLAUDE.md 5.4).
 */
/* eslint-disable no-restricted-globals, no-restricted-syntax -- feature-detect the offscreen API (Chromium) */
import browser from 'webextension-polyfill';

import { extractFromHtml } from './extract';
import { isOutcomeResponse } from './guards';
import { PARSE_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

const OFFSCREEN_PAGE = 'offscreen/offscreen.html';

/**
 * Parses HTML wherever a DOM exists and returns a finished extraction result.
 * The path is chosen by environment capability, not by `__TARGET__` - so it
 * keeps working once Firefox moves to service workers.
 */
export async function extractHtmlOutOfBand(html: string, url: string): Promise<ExtractOutcome> {
  if (typeof DOMParser !== 'undefined') {
    return extractFromHtml(html, url);
  }

  const offscreen = typeof chrome === 'undefined' ? undefined : chrome.offscreen;
  if (offscreen === undefined) {
    throw new Error('This environment cannot parse HTML in the background.');
  }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      reasons: ['DOM_PARSER'],
      justification: 'Parsing the saved page HTML into an article.',
    });
  } catch {
    // An extension may have only one offscreen document. If one already exists
    // (a concurrent save), we simply reuse it.
  }

  try {
    // `createDocument` can return before the document's script registers its
    // listener - the first message then bounces with "receiving end does not
    // exist". Hence a few attempts with a short pause.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: PARSE_REQUEST,
          html,
          url,
        });
        if (!isOutcomeResponse(response)) {
          throw new Error('The offscreen parser did not answer correctly.');
        }
        return response.outcome;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('The offscreen parser did not answer.');
  } finally {
    try {
      await offscreen.closeDocument();
    } catch {
      // The document may already be gone - nothing to clean up.
    }
  }
}
