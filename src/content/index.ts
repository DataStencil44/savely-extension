/**
 * Content script (sciezka A): wstrzykiwany na zadanie przez
 * `scripting.executeScript`, nie deklaratywnie (CLAUDE.md 4.1).
 *
 * Dziala na zywym DOM-ie karty, wiec widzi to, co uzytkownik: tresc po
 * JS-ie strony i za loginem. Nie robi zadnego `fetch`, wiec nie dotyka CORS-u.
 *
 * Uwaga bezpieczenstwa: skrypt zyje w izolowanym swiecie, wiec `DOMParser`
 * i reszta globali uzywanych przez DOMPurify pochodza z naszego realmu -
 * strona nie moze ich podmienic.
 */
import browser from 'webextension-polyfill';

import { extractFromDocument } from '@/lib/extract';
import { isExtractRequest } from '@/lib/guards';
import type { OutcomeResponse } from '@/types/messages';

const READY_FLAG = '__savelyContentReady';

/**
 * Ten sam plik moze zostac wstrzyknięty ponownie (kazdy kolejny zapis w tej
 * samej karcie). Bez straznika mielibysmy kilka listenerow i kilka odpowiedzi
 * na jedno pytanie.
 */
if (!(READY_FLAG in globalThis)) {
  Object.defineProperty(globalThis, READY_FLAG, { value: true });

  browser.runtime.onMessage.addListener(
    (message: unknown): Promise<OutcomeResponse> | undefined => {
      if (!isExtractRequest(message)) return undefined;

      return Promise.resolve({
        type: 'savely:outcome',
        outcome: extractFromDocument(document, document.location.href),
      });
    },
  );
}
