import type { ExtractOutcome } from './article';

export const EXTRACT_REQUEST = 'savely:extract';

export const PARSE_REQUEST = 'savely:parse-html';

export const SAVE_ACTIVE_TAB = 'savely:save-active-tab';

export interface ExtractRequestMessage {
  type: typeof EXTRACT_REQUEST;
}

export interface ParseRequestMessage {
  type: typeof PARSE_REQUEST;
  html: string;
  url: string;
}

export interface SaveActiveTabMessage {
  type: typeof SAVE_ACTIVE_TAB;
}

export type SavelyRequest = ExtractRequestMessage | ParseRequestMessage | SaveActiveTabMessage;

export interface OutcomeResponse {
  type: 'savely:outcome';
  outcome: ExtractOutcome;
  favicon?: string | null;
}

export interface SaveResultMessage {
  type: 'savely:save-result';
  ok: boolean;
  degraded: boolean;
  message: string;
}
