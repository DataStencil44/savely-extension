import { extractFromHtml } from '@/lib/extract';
import { onMessage } from '@/lib/messaging';
import { PARSE_REQUEST } from '@/types/messages';

onMessage(PARSE_REQUEST, (request) =>
  Promise.resolve({
    type: 'savely:outcome',
    outcome: extractFromHtml(request.html, request.url),
  }),
);
