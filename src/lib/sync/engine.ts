import browser from 'webextension-polyfill';

import { announceChange } from '../changes';
import { DB_VERSION, applySync, clearSyncBase, collectForSync, saveSyncBase } from '../db';
import { errorMessage, isRecord } from '../unknown';

import { mergeStates } from './merge';
import { buildFiles, parseFiles } from './payload';
import type { SyncPayload, SyncProvider, SyncReport } from './types';

const STATE_KEY = 'sync-state';

export const SYNC_INTERVAL_MINUTES = 30;

export const SYNC_ALARM = 'savely-sync';

export interface SyncState {
  providerId: string | null;
  auto: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
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

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

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

const SYNC_LOCK = 'savely-sync';

async function exclusively<Result>(run: () => Promise<Result>): Promise<Result> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return run();
  return await navigator.locks.request(SYNC_LOCK, run);
}

export function syncNow(provider: SyncProvider): Promise<SyncReport> {
  return exclusively(() => syncPass(provider));
}

async function syncPass(provider: SyncProvider): Promise<SyncReport> {
  const now = Date.now();

  try {
    const local = await collectForSync();
    const remote = await provider.pull();

    let payload: SyncPayload | null = null;
    if (remote.files !== null) payload = await parseFiles(remote.files);

    const merged = mergeStates({ local, remote: payload, schemaVersion: DB_VERSION, now });
    const outcome = await applySync(merged.plan);
    if (outcome.added + outcome.updated + outcome.deleted > 0) announceChange();

    const revision = await provider.push(await buildFiles(merged.payload), remote.revision);
    await saveSyncBase(merged.base);

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

export async function disconnectSync(provider: SyncProvider): Promise<void> {
  await provider.disconnect();
  await applyAutoSync(false);
  await clearSyncBase();
  await saveSyncState({
    providerId: null,
    auto: false,
    revision: null,
    lastReport: null,
    lastError: null,
  });
}
