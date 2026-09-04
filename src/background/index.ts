/**
 * Background: bezstanowy router zdarzen.
 *
 * Listenery rejestrujemy synchronicznie na najwyzszym poziomie modulu - po
 * wybudzeniu service workera (Chrome) albo strony zdarzen (Firefox) modul
 * startuje od zera, a rejestracja po `await` by nie zdazyla (CLAUDE.md 5.5).
 *
 * Kazde zdarzenie odpala jedna, awaitowana sekwencje w `src/lib/save.ts`.
 * Tutaj zostaje tylko: skad przyszlo zadanie i jak pokazac wynik.
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

/** Powiadomienia o problemach. Badge zostawiamy wolajacemu - patrz nizej. */
async function announce(result: SaveResult, tabId: number | undefined): Promise<void> {
  if (!result.ok) {
    await clearBadge(tabId);
    await notifyProblem(result.message);
    return;
  }

  // Zapis bez tresci tez jest zapisem - badge sie nalezy, ale uzytkownik ma
  // wiedziec, ze na liscie wyladuje sam wpis.
  if (result.degraded) await notifyProblem(result.message);
}

/** Karta ze zdarzenia, a gdy jej nie ma - aktywna karta biezacego okna. */
async function resolveTab(tab?: browser.Tabs.Tab): Promise<browser.Tabs.Tab | undefined> {
  if (tab?.id !== undefined && tab.url !== undefined) return tab;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  return active;
}

/** Sciezka A od zdarzenia do komunikatu. Zwraca wynik dla wolajacego. */
async function saveActiveTab(
  tab: browser.Tabs.Tab | undefined,
): Promise<{ result: SaveResult; tabId: number | undefined }> {
  const resolved = await resolveTab(tab);

  if (resolved?.id === undefined || resolved.url === undefined) {
    const result: SaveResult = {
      ok: false,
      degraded: false,
      itemId: null,
      message: 'Nie widze aktywnej karty do zapisania.',
    };
    await announce(result, undefined);
    return { result, tabId: undefined };
  }

  // Badge z poprzedniego zapisu mogl zostac, gdyby worker zginal w trakcie.
  await clearBadge(resolved.id);
  const result = await savePageInTab(resolved.id, resolved.url);
  await announce(result, resolved.id);
  return { result, tabId: resolved.id };
}

/** Wariant dla zdarzen: czekamy tez na zgasniecie badge'a. */
async function runSaveActiveTab(tab?: browser.Tabs.Tab): Promise<void> {
  const { result, tabId } = await saveActiveTab(tab);
  if (result.ok) await flashSaved(tabId);
}

// Klikniecie ikony. Dopoki manifest ma `action.default_popup`, przegladarka
// otwiera popup i to zdarzenie sie nie odpala - zapis z paska idzie wtedy
// przyciskiem w popupie (wiadomosc SAVE_ACTIVE_TAB nizej). Listener zostaje
// na wypadek wylaczenia popupu.
browser.action.onClicked.addListener((tab) => {
  void runSaveActiveTab(tab);
});

// Skrot klawiszowy (Ctrl+Shift+S / Command+Shift+S).
browser.commands.onCommand.addListener((command, tab) => {
  if (command !== SAVE_COMMAND) return;
  void runSaveActiveTab(tab);
});

/**
 * Alarm dobowej kopii metadanych.
 *
 * `alarms.create` z tym samym ID nadpisuje istniejacy alarm, wiec wolanie go
 * przy kazdej instalacji i starcie przegladarki jest bezpieczne - a konieczne,
 * bo alarmy nie przezywaja aktualizacji rozszerzenia. Pierwsze odpalenie po
 * minucie, zeby nie robic kopii w trakcie instalacji.
 */
function scheduleDailyBackup(): void {
  void browser.alarms.create(BACKUP_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MINUTES });
}

/**
 * Automatyczna synchronizacja. Cicha z zalozenia: bez zgody uzytkownika nie ma
 * providera, a bez providera nie ma czego robic. Blad ladnie ląduje w stanie
 * (`lastError`) i pokazuja go opcje - powiadomienie co 30 minut o tym samym
 * problemie byloby udreka.
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
    // Kopia jest cicha z zalozenia: nie ma o czym powiadamiac, a blad nie moze
    // wywrocic workera - stad wlasna obsluga odrzucenia.
    void createSnapshotIfDue().catch((error: unknown) => {
      console.error('[savely] dobowa kopia nie powiodla sie:', error);
    });
    return;
  }

  if (alarm.name === SYNC_ALARM) {
    void runScheduledSync().catch((error: unknown) => {
      console.warn('[savely] automatyczna synchronizacja nie powiodla sie:', error);
    });
  }
});

/** Alarmy nie przezywaja aktualizacji rozszerzenia - odtwarzamy je przy starcie. */
function restoreAlarms(): void {
  scheduleDailyBackup();
  void loadSyncState().then(
    (state) => applyAutoSync(state.auto),
    () => undefined,
  );
}

browser.runtime.onStartup.addListener(restoreAlarms);

// Menu kontekstowe tworzymy przy instalacji - `create` z tym samym ID przy
// kazdym wybudzeniu rzucaloby bledem. Firefox na Androidzie nie ma menu
// kontekstowego strony, stad obsluga odrzucenia.
browser.runtime.onInstalled.addListener(() => {
  restoreAlarms();

  browser.contextMenus.removeAll().then(
    () => {
      browser.contextMenus.create({
        id: MENU_SAVE_PAGE,
        title: 'Zapisz do Savely',
        contexts: ['page', 'selection'],
      });
      browser.contextMenus.create({
        id: MENU_SAVE_LINK,
        title: 'Zapisz link do Savely',
        contexts: ['link'],
      });
    },
    (error: unknown) => {
      console.warn('[savely] menu kontekstowe niedostepne:', error);
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

  // Sciezka B. `saveLinkInBackground` zaczyna od `permissions.request()`,
  // wiec zadnego `await` przed nia - inaczej Firefox uzna, ze prosba nie
  // wyszla z gestu uzytkownika (CLAUDE.md 5.3).
  void saveLinkInBackground(linkUrl).then(
    async (result) => {
      await announce(result, tab?.id);
      if (result.ok) await flashSaved(tab?.id);
    },
    (error: unknown) => {
      console.error('[savely] zapis linku nie powiodl sie:', error);
      return notifyProblem('Zapis linku nie powiodl sie.');
    },
  );
});

// Zapis z popupu (przycisk "Zapisz te strone").
browser.runtime.onMessage.addListener(
  (message: unknown): Promise<SaveResultMessage> | undefined => {
    if (!isSaveActiveTabRequest(message)) return undefined;

    return saveActiveTab(undefined).then(({ result, tabId }): SaveResultMessage => {
      // Badge miga w tle - popup ma dostac odpowiedz od razu, a nie po dwoch
      // sekundach czekania na zgasniecie znaczka.
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
