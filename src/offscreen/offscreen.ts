/**
 * Dokument offscreen - wylacznie Chromium.
 *
 * Service worker w Chrome nie ma DOM-u, wiec nie ma tez `DOMParser`. Sciezka B
 * (fetch w tle) potrzebuje go do sparsowania pobranego HTML-a. Firefox tego
 * pliku nie uzywa: jego strona tla ma DOM i parsuje u siebie.
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
