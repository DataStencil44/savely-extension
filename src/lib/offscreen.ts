/* eslint-disable no-restricted-globals, no-restricted-syntax -- feature-detect the offscreen API (Chromium) */
import { extractFromHtml } from './extract';
import { sendMessage } from './messaging';
import { PARSE_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

const OFFSCREEN_PAGE = 'offscreen/offscreen.html';

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
    // ignore
  }

  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await sendMessage({ type: PARSE_REQUEST, html, url });
        if (response === null) {
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
      // ignore
    }
  }
}
