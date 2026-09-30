import browser from 'webextension-polyfill';

import {
  isExtractRequest,
  isOutcomeResponse,
  isParseRequest,
  isSaveActiveTabRequest,
  isSaveResultMessage,
} from './guards';
import {
  EXTRACT_REQUEST,
  PARSE_REQUEST,
  SAVE_ACTIVE_TAB,
  type ExtractRequestMessage,
  type OutcomeResponse,
  type ParseRequestMessage,
  type SaveActiveTabMessage,
  type SaveResultMessage,
} from '@/types/messages';

export interface Contracts {
  [EXTRACT_REQUEST]: { request: ExtractRequestMessage; response: OutcomeResponse };
  [PARSE_REQUEST]: { request: ParseRequestMessage; response: OutcomeResponse };
  [SAVE_ACTIVE_TAB]: { request: SaveActiveTabMessage; response: SaveResultMessage };
}

export type MessageType = keyof Contracts;
export type RequestOf<Type extends MessageType> = Contracts[Type]['request'];
export type ResponseOf<Type extends MessageType> = Contracts[Type]['response'];

const REQUEST_GUARDS: { [Type in MessageType]: (value: unknown) => value is RequestOf<Type> } = {
  [EXTRACT_REQUEST]: isExtractRequest,
  [PARSE_REQUEST]: isParseRequest,
  [SAVE_ACTIVE_TAB]: isSaveActiveTabRequest,
};

const RESPONSE_GUARDS: { [Type in MessageType]: (value: unknown) => value is ResponseOf<Type> } = {
  [EXTRACT_REQUEST]: isOutcomeResponse,
  [PARSE_REQUEST]: isOutcomeResponse,
  [SAVE_ACTIVE_TAB]: isSaveResultMessage,
};

export async function sendMessage<Type extends MessageType>(
  request: RequestOf<Type> & { type: Type },
): Promise<ResponseOf<Type> | null> {
  const isResponse = RESPONSE_GUARDS[request.type];
  const response: unknown = await browser.runtime.sendMessage(request);
  return isResponse(response) ? response : null;
}

export async function sendToTab<Type extends MessageType>(
  tabId: number,
  request: RequestOf<Type> & { type: Type },
): Promise<ResponseOf<Type> | null> {
  const isResponse = RESPONSE_GUARDS[request.type];
  const response: unknown = await browser.tabs.sendMessage(tabId, request);
  return isResponse(response) ? response : null;
}

export function onMessage<Type extends MessageType>(
  type: Type,
  handle: (request: RequestOf<Type>) => Promise<ResponseOf<Type>>,
): void {
  const isRequest = REQUEST_GUARDS[type];
  browser.runtime.onMessage.addListener((message: unknown): Promise<ResponseOf<Type>> | undefined =>
    isRequest(message) ? handle(message) : undefined,
  );
}
