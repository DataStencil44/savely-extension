/**
 * The offscreen document - Chromium only.
 *
 * Chrome's service worker has no DOM, and therefore no `DOMParser`. Path B
 * (background fetch) needs one to parse the downloaded HTML. Firefox does not
 * use this file: its background page has a DOM and parses in place.
 */
import browser from 'webextension-polyfill';

import { extractFromHtml } from '@/lib/extract';
import { isParseRequest } from '@/lib/guards';
import type { OutcomeResponse } from '@/types/messages';

browser.runtime.onMessage.addListener((message: unknown): Promise<OutcomeResponse> | undefined => {
  if (!isParseRequest(message)) return undefined;

  return Promise.resolve({
    type: 'savely:outcome',
    outcome: extractFromHtml(message.html, message.url),
  });
});
