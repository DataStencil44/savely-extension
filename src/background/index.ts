/**
 * Background: a stateless event router.
 *
 * Listeners are registered synchronously at the top level of the module - once
 * the service worker (Chrome) or the event page (Firefox) wakes up, the module
 * starts from scratch and a registration after an `await` would be too late
 * (CLAUDE.md 5.5).
 *
 * Every event triggers one awaited sequence in `src/lib/save.ts`. What stays
 * here is only: where the request came from and how to show the result.
 */
import browser from 'webextension-polyfill';

import { createSnapshotIfDue } from '@/lib/db';
import { clearBadge, flashSaved, notifyProblem } from '@/lib/feedback';
import { SYNC_ALARM, activeProvider, applyAutoSync, loadSyncState, syncNow } from '@/lib/sync';
import { isSaveActiveTabRequest } from '@/lib/guards';
import { savePageInTab, saveLinkInBackground } from '@/lib/save';
import type { SaveResult } from '@/lib/save';
import type { SaveResultMessage } from '@/types/messages';

const SAVE_COMMAND = 'save-current-page';
const MENU_SAVE_PAGE = 'savely-save-page';
const MENU_SAVE_LINK = 'savely-save-link';
const BACKUP_ALARM = 'savely-daily-backup';
const DAY_MINUTES = 24 * 60;

/** Problem notifications. The badge is left to the caller - see below. */
async function announce(result: SaveResult, tabId: number | undefined): Promise<void> {
  if (!result.ok) {
    await clearBadge(tabId);
    await notifyProblem(result.message);
    return;
  }

  // A save without content is still a save - the badge is earned, but the user
  // should know that only the entry itself lands in the list.
  if (result.degraded) await notifyProblem(result.message);
}

/** The tab from the event, or - when there is none - the active tab of the current window. */
async function resolveTab(tab?: browser.Tabs.Tab): Promise<browser.Tabs.Tab | undefined> {
  if (tab?.id !== undefined && tab.url !== undefined) return tab;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return active;
}

/** Path A from the event to the message. Returns the result for the caller. */
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

  // A badge from a previous save could linger if the worker died mid-way.
  await clearBadge(resolved.id);
  const result = await savePageInTab(resolved.id, resolved.url);
  await announce(result, resolved.id);
  return { result, tabId: resolved.id };
}

/** The variant for events: we also wait for the badge to fade. */
async function runSaveActiveTab(tab?: browser.Tabs.Tab): Promise<void> {
  const { result, tabId } = await saveActiveTab(tab);
  if (result.ok) await flashSaved(tabId);
}

// Toolbar icon click. As long as the manifest has `action.default_popup`, the
// browser opens the popup and this event never fires - saving from the toolbar
// then goes through the popup button (the SAVE_ACTIVE_TAB message below). The
// listener stays in case the popup is disabled.
browser.action.onClicked.addListener((tab) => {
  void runSaveActiveTab(tab);
});

// Keyboard shortcut (Ctrl+Shift+S / Command+Shift+S).
browser.commands.onCommand.addListener((command, tab) => {
  if (command !== SAVE_COMMAND) return;
  void runSaveActiveTab(tab);
});

/**
 * The daily metadata backup alarm.
 *
 * `alarms.create` with the same ID overwrites an existing alarm, so calling it
 * on every install and browser start is safe - and necessary, because alarms do
 * not survive an extension update. The first run is a minute in, so we do not
 * take a backup during installation.
 */
function scheduleDailyBackup(): void {
  void browser.alarms.create(BACKUP_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MINUTES });
}

/**
 * Automatic sync. Silent by design: without the user's consent there is no
 * provider, and without a provider there is nothing to do. An error lands in
 * the state (`lastError`) and the options page shows it - a notification every
 * 30 minutes about the same problem would be torture.
 */
async function runScheduledSync(): Promise<void> {
  const state = await loadSyncState();
  if (!state.auto) return;

  const provider = await activeProvider();
  if (provider === null) return;

  await syncNow(provider);
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    // The backup is silent by design: there is nothing to announce, and an
    // error must not take down the worker - hence the explicit rejection handler.
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

/** Alarms do not survive an extension update - we recreate them at startup. */
function restoreAlarms(): void {
  scheduleDailyBackup();
  void loadSyncState().then(
    (state) => applyAutoSync(state.auto),
    () => undefined,
  );
}

browser.runtime.onStartup.addListener(restoreAlarms);

// The context menu is created on install - `create` with the same ID on every
// wake-up would throw. Firefox for Android has no page context menu, hence the
// rejection handler.
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

  // Path B. `saveLinkInBackground` starts with `permissions.request()`, so no
  // `await` before it - otherwise Firefox decides the request did not come from
  // a user gesture (CLAUDE.md 5.3).
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

// Saving from the popup (the "Save this page" button).
browser.runtime.onMessage.addListener(
  (message: unknown): Promise<SaveResultMessage> | undefined => {
    if (!isSaveActiveTabRequest(message)) return undefined;

    return saveActiveTab(undefined).then(({ result, tabId }): SaveResultMessage => {
      // The badge flashes in the background - the popup should get its answer
      // immediately, not after two seconds of waiting for the badge to fade.
      if (result.ok) void flashSaved(tabId);

      return {
        type: 'savely:save-result',
        ok: result.ok,
        degraded: result.degraded,
        message: result.message,
      };
    });
  },
);
