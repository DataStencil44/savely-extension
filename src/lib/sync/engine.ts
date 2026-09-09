/**
 * The sync engine: pull -> merge -> write locally -> push.
 *
 * The order is not accidental. First we fetch the remote state, then merge it
 * with the local one in memory (`merge.ts`, a pure function), then write the
 * result to the database in a single transaction, and only at the end push.
 * If anything fails along the way, the worst case is "updated locally, not
 * pushed" - the next run finishes it. The reverse order (push first) could
 * leave a state on the other side that exists nowhere else.
 *
 * The sync state lives in `storage.local`, not `storage.sync`: it describes
 * THIS device, and the provider's credentials have no business leaving the
 * machine.
 */
import browser from 'webextension-polyfill';

import { announceChange } from '../changes';
import { DB_VERSION, applySync, collectForSync } from '../db';

import { mergeStates } from './merge';
import { buildFiles, parseFiles } from './payload';
import type { SyncPayload, SyncProvider, SyncReport } from './types';

const STATE_KEY = 'sync-state';

/** How often the automatic run fires. A shorter alarm period makes no sense for
 *  data that changes at the pace of reading articles. */
export const SYNC_INTERVAL_MINUTES = 30;

export const SYNC_ALARM = 'savely-sync';

export interface SyncState {
  /** `null` = sync is off. */
  providerId: string | null;
  /** The automatic run every `SYNC_INTERVAL_MINUTES`. The manual button is independent. */
  auto: boolean;
  lastSyncAt: number | null;
  /** The message from the last failed attempt - shown on the options page. */
  lastError: string | null;
  /** The revision marker of the last pushed bundle (for diagnostics). */
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

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * The report of the last run. Every field is a count, so a field that is not
 * one is nothing - the options page prints these straight into a sentence, and
 * a `lastReport` left behind by an older version, or by a half-finished write,
 * would otherwise reach it as `undefined new, NaN updated`.
 */
function parseReport(value: unknown): SyncReport | null {
  if (!isRecord(value)) return null;
  return {
    at: asNullableNumber(value['at']) ?? 0,
    added: asCount(value['added']),
    updated: asCount(value['updated']),
    deleted: asCount(value['deleted']),
    contents: asCount(value['contents']),
    highlights: asCount(value['highlights']),
    pushed: asCount(value['pushed']),
    conflicts: asCount(value['conflicts']),
  };
}

/** State from `storage.local` is external data too - validate it (CLAUDE.md 3). */
export function parseSyncState(value: unknown): SyncState {
  if (!isRecord(value)) return { ...DEFAULT_SYNC_STATE };

  return {
    providerId: asNullableString(value['providerId']),
    auto: value['auto'] === true,
    lastSyncAt: asNullableNumber(value['lastSyncAt']),
    lastError: asNullableString(value['lastError']),
    revision: asNullableString(value['revision']),
    lastReport: parseReport(value['lastReport']),
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
 * Turns the automatic alarm on or off. Called from the options page on the
 * toggle and from the background at startup - alarms do not survive an
 * extension update, and `alarms.create` with the same ID simply overwrites the
 * previous one.
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
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error';
}

/**
 * One full pass. It rethrows, but always leaves a trace in the state - the
 * alarm-driven run has nobody to show an exception to, so the options page has
 * to be able to say what went wrong last time.
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
    // The local write is done; the push that follows changes nothing here, so
    // an open list may as well hear about it now rather than after the network.
    if (outcome.added + outcome.updated + outcome.deleted > 0) announceChange();

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
