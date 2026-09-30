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
import type { ArticleStub, ExtractedArticle, ExtractOutcome, ExtractProblem } from '@/types/article';
import { isRecord } from './unknown';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isExtractRequest(value: unknown): value is ExtractRequestMessage {
  return isRecord(value) && value['type'] === EXTRACT_REQUEST;
}

export function isParseRequest(value: unknown): value is ParseRequestMessage {
  return (
    isRecord(value) &&
    value['type'] === PARSE_REQUEST &&
    isString(value['html']) &&
    isString(value['url'])
  );
}

export function isSaveActiveTabRequest(value: unknown): value is SaveActiveTabMessage {
  return isRecord(value) && value['type'] === SAVE_ACTIVE_TAB;
}

const PROBLEMS: readonly string[] = ['unsupported-document', 'empty-document', 'no-article'];

function isProblem(value: unknown): value is ExtractProblem {
  return isString(value) && PROBLEMS.includes(value);
}

function isArticle(value: unknown): value is ExtractedArticle {
  return (
    isRecord(value) &&
    isString(value['title']) &&
    isString(value['excerpt']) &&
    isNullableString(value['byline']) &&
    isNullableString(value['siteName']) &&
    isNullableString(value['lang']) &&
    isString(value['html']) &&
    isString(value['text']) &&
    isNumber(value['wordCount']) &&
    isNumber(value['estReadingMinutes']) &&
    isString(value['resolvedUrl']) &&
    isStringArray(value['faviconUrls'])
  );
}

function isStub(value: unknown): value is ArticleStub {
  return (
    isRecord(value) &&
    isString(value['title']) &&
    isString(value['excerpt']) &&
    isNullableString(value['siteName']) &&
    isNullableString(value['lang']) &&
    isString(value['resolvedUrl']) &&
    isStringArray(value['faviconUrls'])
  );
}

export function isExtractOutcome(value: unknown): value is ExtractOutcome {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'article':
      return isArticle(value['article']);
    case 'stub':
      return isProblem(value['problem']) && isStub(value['stub']);
    case 'refused':
      return isProblem(value['problem']) && isString(value['message']);
    default:
      return false;
  }
}

export function isOutcomeResponse(value: unknown): value is OutcomeResponse {
  return (
    isRecord(value) &&
    value['type'] === 'savely:outcome' &&
    isExtractOutcome(value['outcome']) &&
    (value['favicon'] === undefined || isNullableString(value['favicon']))
  );
}

export function isSaveResultMessage(value: unknown): value is SaveResultMessage {
  return (
    isRecord(value) &&
    value['type'] === 'savely:save-result' &&
    typeof value['ok'] === 'boolean' &&
    typeof value['degraded'] === 'boolean' &&
    isString(value['message'])
  );
}
