/**
 * Parsowanie HTML-a pobranego w tle (sciezka B), niezaleznie od silnika.
 *
 * Firefox: strona tla ma DOM, wiec `DOMParser` jest na miejscu.
 * Chromium: service worker nie ma DOM-u - HTML jedzie do dokumentu offscreen,
 * ktory istnieje tylko na czas jednego parsowania.
 *
 * To jedyne miejsce w `src/` z `chrome.*`: API `offscreen` nie ma ani
 * w Firefoksie, ani w webextension-polyfill (dopuszczony wyjatek, CLAUDE.md 5.4).
 */
/* eslint-disable no-restricted-globals, no-restricted-syntax -- feature-detect API offscreen (Chromium) */
import browser from 'webextension-polyfill';

import { extractFromHtml } from './extract';
import { isOutcomeResponse } from './guards';
import { PARSE_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

const OFFSCREEN_PAGE = 'offscreen/offscreen.html';

/**
 * Parsuje HTML tam, gdzie jest DOM, i zwraca gotowy wynik ekstrakcji.
 * Wybor sciezki po zdolnosciach srodowiska, nie po `__TARGET__` - dzieki temu
 * dziala tez tam, gdzie Firefox kiedys przejdzie na service workery.
 */
export async function extractHtmlOutOfBand(html: string, url: string): Promise<ExtractOutcome> {
  if (typeof DOMParser !== 'undefined') {
    return extractFromHtml(html, url);
  }

  const offscreen = typeof chrome === 'undefined' ? undefined : chrome.offscreen;
  if (offscreen === undefined) {
    throw new Error('To srodowisko nie potrafi sparsowac HTML-a w tle.');
  }

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_PAGE,
      reasons: ['DOM_PARSER'],
      justification: 'Parsowanie HTML zapisywanej strony do postaci artykulu.',
    });
  } catch {
    // Rozszerzenie moze miec tylko jeden dokument offscreen. Jesli juz istnieje
    // (rownolegly zapis), po prostu z niego korzystamy.
  }

  try {
    // `createDocument` potrafi wrocic, zanim skrypt dokumentu zdazy zarejestrowac
    // listenera - wtedy pierwsza wiadomosc odbija sie "receiving end does not
    // exist". Stad kilka podejsc z krotka przerwa.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: PARSE_REQUEST,
          html,
          url,
        });
        if (!isOutcomeResponse(response)) {
          throw new Error('Parser offscreen nie odpowiedzial poprawnie.');
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
      : new Error('Parser offscreen nie odpowiedzial.');
  } finally {
    try {
      await offscreen.closeDocument();
    } catch {
      // Dokument mogl juz zniknac - nie ma czego sprzatac.
    }
  }
}
