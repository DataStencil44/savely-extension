import browser from 'webextension-polyfill';

import { createSnapshotIfDue } from '@/lib/db';
import { clearBadge, flashSaved, notifyProblem } from '@/lib/feedback';
import { SYNC_ALARM, activeProvider, applyAutoSync, loadSyncState, syncNow } from '@/lib/sync';
import { onMessage } from '@/lib/messaging';
import { savePageInTab, saveLinkInBackground } from '@/lib/save';
import type { SaveResult } from '@/lib/save';
import { SAVE_ACTIVE_TAB, type SaveResultMessage } from '@/types/messages';

const SAVE_COMMAND = 'save-current-page';
const MENU_SAVE_PAGE = 'savely-save-page';
const MENU_SAVE_LINK = 'savely-save-link';
const BACKUP_ALARM = 'savely-daily-backup';
const DAY_MINUTES = 24 * 60;

async function announce(result: SaveResult, tabId: number | undefined): Promise<void> {
  if (!result.ok) {
    await clearBadge(tabId);
    await notifyProblem(result.message);
    return;
  }

  if (result.degraded) await notifyProblem(result.message);
}

async function resolveTab(tab?: browser.Tabs.Tab): Promise<browser.Tabs.Tab | undefined> {
  if (tab?.id !== undefined && tab.url !== undefined) return tab;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return active;
}

async function saveActiveTab(
  tab: browser.Tabs.Tab | undefined,
): Promise<{ result: SaveResult; tabId: number | undefined }> {
  const resolved = await resolveTab(tab);

  if (resolved?.id === undefined || resolved.url === undefined) {
    const result: SaveResult = {
      ok: false,
      degraded: false,
      itemId: null,
      message: 'I cannot see an active tab to save.',
    };
    await announce(result, undefined);
    return { result, tabId: undefined };
  }

  await clearBadge(resolved.id);
  const result = await savePageInTab(resolved.id, resolved.url);
  await announce(result, resolved.id);
  return { result, tabId: resolved.id };
}

async function runSaveActiveTab(tab?: browser.Tabs.Tab): Promise<void> {
  const { result, tabId } = await saveActiveTab(tab);
  if (result.ok) await flashSaved(tabId);
}

browser.action.onClicked.addListener((tab) => {
  void runSaveActiveTab(tab);
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command !== SAVE_COMMAND) return;
  void runSaveActiveTab(tab);
});

function scheduleDailyBackup(): void {
  void browser.alarms.create(BACKUP_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MINUTES });
}

async function runScheduledSync(): Promise<void> {
  const state = await loadSyncState();
  if (!state.auto) return;

  const provider = await activeProvider();
  if (provider === null) return;

  await syncNow(provider);
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    void createSnapshotIfDue().catch((error: unknown) => {
      console.error('[savely] the daily backup failed:', error);
    });
    return;
  }

  if (alarm.name === SYNC_ALARM) {
    void runScheduledSync().catch((error: unknown) => {
      console.warn('[savely] automatic sync failed:', error);
    });
  }
});

function restoreAlarms(): void {
  scheduleDailyBackup();
  void loadSyncState().then(
    (state) => applyAutoSync(state.auto),
    () => undefined,
  );
}

browser.runtime.onStartup.addListener(restoreAlarms);

browser.runtime.onInstalled.addListener(() => {
  restoreAlarms();

  browser.contextMenus.removeAll().then(
    () => {
      browser.contextMenus.create({
        id: MENU_SAVE_PAGE,
        title: 'Save to Savely',
        contexts: ['page', 'selection'],
      });
      browser.contextMenus.create({
        id: MENU_SAVE_LINK,
        title: 'Save link to Savely',
        contexts: ['link'],
      });
    },
    (error: unknown) => {
      console.warn('[savely] context menu unavailable:', error);
    },
  );
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SAVE_PAGE) {
    void runSaveActiveTab(tab);
    return;
  }

  if (info.menuItemId !== MENU_SAVE_LINK) return;

  const linkUrl = typeof info.linkUrl === 'string' ? info.linkUrl : undefined;
  if (linkUrl === undefined) return;

  void saveLinkInBackground(linkUrl).then(
    async (result) => {
      await announce(result, tab?.id);
      if (result.ok) await flashSaved(tab?.id);
    },
    (error: unknown) => {
      console.error('[savely] saving the link failed:', error);
      return notifyProblem('Saving the link failed.');
    },
  );
});

onMessage(SAVE_ACTIVE_TAB, () =>
  saveActiveTab(undefined).then(({ result, tabId }): SaveResultMessage => {
    if (result.ok) void flashSaved(tabId);

    return {
      type: 'savely:save-result',
      ok: result.ok,
      degraded: result.degraded,
      message: result.message,
    };
  }),
);
