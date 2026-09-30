import { extractFromDocument } from '@/lib/extract';
import { captureFavicon, faviconUrlsOf } from '@/lib/favicon';
import { onMessage } from '@/lib/messaging';
import { EXTRACT_REQUEST, type OutcomeResponse } from '@/types/messages';

const READY_FLAG = '__savelyContentReady';

if (!(READY_FLAG in globalThis)) {
  Object.defineProperty(globalThis, READY_FLAG, { value: true });

  onMessage(EXTRACT_REQUEST, respond);
}

async function respond(): Promise<OutcomeResponse> {
  const outcome = extractFromDocument(document, document.location.href);
  return { type: 'savely:outcome', outcome, favicon: await captureFavicon(faviconUrlsOf(outcome)) };
}
