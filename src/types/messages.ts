/**
 * Kontrakty wiadomosci miedzy kontekstami rozszerzenia.
 * Walidacja przychodzacych danych: `src/lib/guards.ts` (CLAUDE.md 3).
 */
import type { ExtractOutcome } from './article';

/** tlo -> content script w karcie: "wyciagnij tresc z tej strony". */
export const EXTRACT_REQUEST = 'savely:extract';

/** tlo -> dokument offscreen (tylko Chromium): "sparsuj ten HTML i wyciagnij tresc". */
export const PARSE_REQUEST = 'savely:parse-html';

/** popup -> tlo: "zapisz strone z aktywnej karty" (sciezka A z paska narzedzi). */
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

/** Odpowiedz ekstrakcji i parsowania - ten sam ksztalt, zeby tlo mialo jedna sciezke. */
export interface OutcomeResponse {
  type: 'savely:outcome';
  outcome: ExtractOutcome;
}

/** Odpowiedz tla na `SAVE_ACTIVE_TAB` - gotowa do pokazania w popupie. */
export interface SaveResultMessage {
  type: 'savely:save-result';
  ok: boolean;
  degraded: boolean;
  message: string;
}
