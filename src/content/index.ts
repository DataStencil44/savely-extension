/**
 * Content script (path A): injected on demand through
 * `scripting.executeScript`, not declaratively (CLAUDE.md 4.1).
 *
 * It runs against the tab's live DOM, so it sees what the user sees: content
 * after the page's own JS and behind a login. It performs no `fetch`, so it
 * never touches CORS.
 *
 * Security note: the script lives in an isolated world, so `DOMParser` and the
 * other globals DOMPurify uses come from our realm - the page cannot swap them
 * out.
 */
import browser from 'webextension-polyfill';

import { extractFromDocument } from '@/lib/extract';
import { isExtractRequest } from '@/lib/guards';
import type { OutcomeResponse } from '@/types/messages';

const READY_FLAG = '__savelyContentReady';

/**
 * The same file can be injected again (every subsequent save in the same tab).
 * Without a guard we would end up with several listeners and several answers to
 * a single question.
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
