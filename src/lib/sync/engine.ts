/**
 * Silnik synchronizacji: pull -> scal -> zapisz lokalnie -> push.
 *
 * Kolejność nie jest przypadkowa. Najpierw ściągamy stan zdalny, potem scalamy
 * go z lokalnym w pamięci (`merge.ts`, czysta funkcja), potem zapisujemy wynik
 * do bazy w jednej transakcji, a dopiero na końcu wysyłamy. Gdy cokolwiek
 * padnie po drodze, gorszy scenariusz to „lokalnie zaktualizowane, niewysłane" -
 * następne uruchomienie to dokończy. Odwrotna kolejność (najpierw push) mogłaby
 * zostawić po drugiej stronie stan, którego nigdzie nie ma.
 *
 * Stan synchronizacji siedzi w `storage.local`, nie w `storage.sync`: dotyczy
 * TEGO urządzenia, a poświadczenia providera nie mają prawa opuścić maszyny.
 */
import browser from 'webextension-polyfill';

import { DB_VERSION, applySync, collectForSync } from '../db';

import { mergeStates } from './merge';
import { buildFiles, parseFiles } from './payload';
import type { SyncPayload, SyncProvider, SyncReport } from './types';

const STATE_KEY = 'sync-state';

/** Co ile minut chodzi automat. Alarm o krótszym okresie nie ma sensu przy
 *  danych, które zmieniają się w rytmie czytania artykułów. */
export const SYNC_INTERVAL_MINUTES = 30;

export const SYNC_ALARM = 'savely-sync';

export interface SyncState {
  /** `null` = synchronizacja wyłączona. */
  providerId: string | null;
  /** Automat co `SYNC_INTERVAL_MINUTES`. Ręczny przycisk działa niezależnie. */
  auto: boolean;
  lastSyncAt: number | null;
  /** Komunikat z ostatniej nieudanej próby - pokazywany w opcjach. */
  lastError: string | null;
  /** Znacznik wersji ostatnio wysłanej paczki (do diagnostyki). */
  revision: string | null;
  lastReport: SyncReport | null;
}

export const DEFAULT_SYNC_STATE: SyncState = {
  providerId: null,
  auto: false,
  lastSyncAt: null,
  lastError: null,
  revision: null,
  lastReport: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Stan ze `storage.local` to też dane z zewnątrz - waliduj (CLAUDE.md 3). */
export function parseSyncState(value: unknown): SyncState {
  if (!isRecord(value)) return { ...DEFAULT_SYNC_STATE };

  const report = value['lastReport'];
  return {
    providerId: asNullableString(value['providerId']),
    auto: value['auto'] === true,
    lastSyncAt: asNullableNumber(value['lastSyncAt']),
    lastError: asNullableString(value['lastError']),
    revision: asNullableString(value['revision']),
    // Raport służy wyłącznie do pokazania „co się stało ostatnio" - nie ma sensu
    // walidować go pole po polu, ale nie może wysadzić widoku.
    lastReport: isRecord(report) ? (report as unknown as SyncReport) : null,
  };
}

export async function loadSyncState(): Promise<SyncState> {
  try {
    const stored = await browser.storage.local.get(STATE_KEY);
    return parseSyncState(stored[STATE_KEY]);
  } catch {
    return { ...DEFAULT_SYNC_STATE };
  }
}

export async function saveSyncState(patch: Partial<SyncState>): Promise<SyncState> {
  const next = { ...(await loadSyncState()), ...patch };
  await browser.storage.local.set({ [STATE_KEY]: next });
  return next;
}

/**
 * Włącza albo gasi alarm automatu. Wołane z opcji przy przełączniku i z tła
 * przy starcie - alarmy nie przeżywają aktualizacji rozszerzenia, a
 * `alarms.create` z tym samym ID po prostu nadpisuje poprzedni.
 */
export async function applyAutoSync(auto: boolean): Promise<void> {
  if (auto) {
    await browser.alarms.create(SYNC_ALARM, {
      delayInMinutes: SYNC_INTERVAL_MINUTES,
      periodInMinutes: SYNC_INTERVAL_MINUTES,
    });
    return;
  }
  await browser.alarms.clear(SYNC_ALARM);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'nieznany błąd';
}

/**
 * Jedno pełne przejście. Rzuca dalej, ale zawsze zostawia ślad w stanie -
 * automat z alarmu nie ma komu pokazać wyjątku, więc opcje muszą móc powiedzieć,
 * co ostatnio poszło nie tak.
 */
export async function syncNow(provider: SyncProvider): Promise<SyncReport> {
  const now = Date.now();

  try {
    const local = await collectForSync();
    const remote = await provider.pull();

    let payload: SyncPayload | null = null;
    if (remote.files !== null) payload = await parseFiles(remote.files);

    const merged = mergeStates({ local, remote: payload, schemaVersion: DB_VERSION, now });
    const outcome = await applySync(merged.plan);
    const revision = await provider.push(await buildFiles(merged.payload), remote.revision);

    const report: SyncReport = {
      at: now,
      added: outcome.added,
      updated: outcome.updated,
      deleted: outcome.deleted,
      contents: outcome.contents,
      highlights: outcome.highlights,
      pushed: merged.payload.items.length,
      conflicts: merged.conflicts,
    };

    await saveSyncState({
      providerId: provider.id,
      lastSyncAt: now,
      lastError: null,
      revision,
      lastReport: report,
    });

    return report;
  } catch (error) {
    await saveSyncState({ lastError: errorMessage(error) });
    throw error;
  }
}
