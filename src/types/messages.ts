/**
 * Message contracts between the extension's contexts.
 * Validation of incoming data: `src/lib/guards.ts` (CLAUDE.md 3).
 */
import type { ExtractOutcome } from './article';

/** background -> content script in the tab: "extract the content of this page". */
export const EXTRACT_REQUEST = 'savely:extract';

/** background -> offscreen document (Chromium only): "parse this HTML and extract the content". */
export const PARSE_REQUEST = 'savely:parse-html';

/** popup -> background: "save the page in the active tab" (path A from the toolbar). */
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

/** The extraction and parse response - one shape, so the background has a single path. */
export interface OutcomeResponse {
  type: 'savely:outcome';
  outcome: ExtractOutcome;
}

/** The background's answer to `SAVE_ACTIVE_TAB` - ready to show in the popup. */
export interface SaveResultMessage {
  type: 'savely:save-result';
  ok: boolean;
  degraded: boolean;
  message: string;
}
