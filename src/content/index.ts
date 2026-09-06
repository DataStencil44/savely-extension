/**
 * Content script (path A): injected on demand through
 * `scripting.executeScript`, not declaratively (CLAUDE.md 4.1).
 *
 * It runs against the tab's live DOM, so it sees what the user sees: content
 * after the page's own JS and behind a login. Its one request is for the site
 * icon, and it goes out from here precisely to avoid CORS: from the page's own
 * origin the icon is a same-origin file, while the same fetch from the
 * background would need a host permission we do not ask for on this path.
 * An icon the page declares on *another* host is still out of reach here - the
 * candidate list ends with the page's own `/favicon.ico` for that case.
 *
 * Security note: the script lives in an isolated world, so `DOMParser` and the
 * other globals DOMPurify uses come from our realm - the page cannot swap them
 * out.
 */
import browser from 'webextension-polyfill';

import { extractFromDocument } from '@/lib/extract';
import { captureFavicon, faviconUrlsOf } from '@/lib/favicon';
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

      return respond();
    },
  );
}

/**
 * The extraction first (synchronous, on the live DOM), the icon after it. A
 * failed or slow icon fetch resolves to `null` inside `captureFavicon`, so the
 * answer is never held up by more than its timeout and a save never fails over
 * a picture.
 */
async function respond(): Promise<OutcomeResponse> {
  const outcome = extractFromDocument(document, document.location.href);
  return { type: 'savely:outcome', outcome, favicon: await captureFavicon(faviconUrlsOf(outcome)) };
}
