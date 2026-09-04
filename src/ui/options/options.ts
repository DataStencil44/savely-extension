/**
 * Strona opcji: całe przenoszenie danych w jednym miejscu.
 *
 * Bez backendu to jedyna droga wejścia i wyjścia danych, więc każda operacja
 * musi być zrozumiała i odwracalna: eksport nic nie zmienia, import wyłącznie
 * dokłada, kopie automatyczne siedzą w bazie, a jedyne nieodwracalne działanie
 * (kasowanie) wymaga potwierdzenia w oknie dialogowym.
 *
 * Parsowanie i walidacja plików siedzą w `src/lib/backup.ts`, zapis w
 * `src/lib/db.ts` - tutaj zostaje sam widok i raport z tego, co się stało.
 */
import browser from 'webextension-polyfill';

import {
  ImportError,
  backupFileName,
  bookmarksFileName,
  buildBackup,
  buildBookmarksHtml,
  parseImportFile,
  serializeBackup,
  summarizeProblems,
  type ImportPlan,
} from '@/lib/backup';
import {
  DB_VERSION,
  SNAPSHOT_LIMIT,
  clearAllData,
  createSnapshot,
  dataStats,
  exportAll,
  importDump,
  listAllItems,
  listSnapshots,
  restoreSnapshot,
  type MergeOutcome,
} from '@/lib/db';
import {
  SYNC_INTERVAL_MINUTES,
  applyAutoSync,
  getProvider,
  listProviders,
  loadSyncState,
  saveSyncState,
  syncNow,
  type SyncProvider,
} from '@/lib/sync';
import { showToast } from '@/ui/list/toast';

/** Blob musi przeżyć start pobierania - przeglądarka kopiuje go asynchronicznie. */
const REVOKE_MS = 60_000;

const el = {
  stats: document.querySelector<HTMLDListElement>('#stats'),
  storage: document.querySelector<HTMLParagraphElement>('#storage'),
  openList: document.querySelector<HTMLButtonElement>('#open-list'),
  exportJson: document.querySelector<HTMLButtonElement>('#export-json'),
  exportHtml: document.querySelector<HTMLButtonElement>('#export-html'),
  importFile: document.querySelector<HTMLInputElement>('#import-file'),
  report: document.querySelector<HTMLDivElement>('#report'),
  syncProvider: document.querySelector<HTMLSelectElement>('#sync-provider'),
  syncLocation: document.querySelector<HTMLParagraphElement>('#sync-location'),
  syncConnect: document.querySelector<HTMLDivElement>('#sync-connect'),
  syncConnected: document.querySelector<HTMLDivElement>('#sync-connected'),
  syncSecret: document.querySelector<HTMLInputElement>('#sync-secret'),
  syncSecretLabel: document.querySelector<HTMLSpanElement>('#sync-secret-label'),
  syncHelp: document.querySelector<HTMLParagraphElement>('#sync-help'),
  syncAuthorize: document.querySelector<HTMLButtonElement>('#sync-authorize'),
  syncTarget: document.querySelector<HTMLParagraphElement>('#sync-target'),
  syncStatus: document.querySelector<HTMLParagraphElement>('#sync-status'),
  syncNow: document.querySelector<HTMLButtonElement>('#sync-now'),
  syncDisconnect: document.querySelector<HTMLButtonElement>('#sync-disconnect'),
  syncAuto: document.querySelector<HTMLInputElement>('#sync-auto'),
  snapshots: document.querySelector<HTMLUListElement>('#snapshots'),
  snapshotNow: document.querySelector<HTMLButtonElement>('#snapshot-now'),
  wipe: document.querySelector<HTMLButtonElement>('#wipe'),
  toast: document.querySelector<HTMLDivElement>('#toast'),
  dialog: document.querySelector<HTMLDialogElement>('#confirm-dialog'),
  dialogTitle: document.querySelector<HTMLHeadingElement>('#confirm-title'),
  dialogText: document.querySelector<HTMLParagraphElement>('#confirm-text'),
  dialogOk: document.querySelector<HTMLButtonElement>('#confirm-ok'),
  dialogCancel: document.querySelector<HTMLButtonElement>('#confirm-cancel'),
};

const numbers = new Intl.NumberFormat('pl-PL');

function toast(message: string): void {
  if (el.toast !== null) showToast(el.toast, { message });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

// ---------------------------------------------------------------------------
// Liczniki i miejsce
// ---------------------------------------------------------------------------

function statTile(value: number, label: string): HTMLDivElement {
  const tile = element('div', 'stat');
  tile.append(
    element('p', 'stat__value', numbers.format(value)),
    element('p', 'stat__label', label),
  );
  return tile;
}

async function renderStats(): Promise<void> {
  if (el.stats === null) return;
  const stats = await dataStats();

  el.stats.replaceChildren(
    statTile(stats.items, 'pozycji'),
    statTile(stats.unread, 'do przeczytania'),
    statTile(stats.archived, 'w archiwum'),
    statTile(stats.favorite, 'ulubionych'),
    statTile(stats.contents, 'z treścią offline'),
    statTile(stats.highlights, 'podświetleń'),
  );
}

function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace('.', ',')} ${units[unit] ?? 'B'}`;
}

/**
 * `navigator.storage.estimate()` podaje zużycie całego origin rozszerzenia,
 * nie samej bazy, i zaokrągla wynik - traktujemy je jako rząd wielkości.
 * Na starszych silnikach (Firefox na Androidzie) potrafi go w ogóle nie być.
 */
async function renderStorage(): Promise<void> {
  if (el.storage === null) return;

  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.usage === undefined) {
    el.storage.textContent = 'Przeglądarka nie podaje zajętego miejsca.';
    return;
  }

  const used = formatBytes(estimate.usage);
  if (estimate.quota === undefined || estimate.quota === 0) {
    el.storage.textContent = `Zajęte miejsce: ${used}.`;
    return;
  }

  const percent = ((estimate.usage / estimate.quota) * 100).toFixed(1).replace('.', ',');
  el.storage.textContent = `Zajęte miejsce: ${used} z ${formatBytes(estimate.quota)} (${percent}%).`;
}

// ---------------------------------------------------------------------------
// Eksport
// ---------------------------------------------------------------------------

/**
 * Pobranie przez `downloads` API - działa tak samo na obu silnikach i pozwala
 * podsunąć nazwę pliku. Gdyby uprawnienia zabrakło, zostaje zwykły link:
 * lepiej pobrać plik inaczej niż nie pobrać go wcale.
 */
async function downloadFile(content: string, fileName: string, mime: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));

  try {
    await browser.downloads.download({ url, filename: fileName, saveAs: true });
  } catch (error) {
    console.warn('[savely] downloads API niedostępne, pobieram linkiem:', error);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, REVOKE_MS);
  }
}

async function exportJson(): Promise<void> {
  const now = Date.now();
  const dump = await exportAll();
  await downloadFile(
    serializeBackup(buildBackup(dump, DB_VERSION, now)),
    backupFileName(now),
    'application/json',
  );
  toast(`Kopia gotowa: ${numbers.format(dump.items.length)} pozycji.`);
}

async function exportBookmarks(): Promise<void> {
  const now = Date.now();
  const items = await listAllItems();
  await downloadFile(buildBookmarksHtml(items, now), bookmarksFileName(now), 'text/html');
  toast(`Zakładki gotowe: ${numbers.format(items.length)} pozycji.`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function reportLine(text: string): HTMLParagraphElement {
  return element('p', 'report__line', text);
}

function renderImportError(message: string): void {
  if (el.report === null) return;
  el.report.className = 'report report--error';
  el.report.replaceChildren(reportLine(`Nie zaimportowano nic: ${message}`));
  el.report.hidden = false;
}

function renderReport(fileName: string, plan: ImportPlan, outcome: MergeOutcome): void {
  if (el.report === null) return;

  const source = plan.source === 'json' ? 'kopia Savely' : 'eksport z Pocketa';
  const skipped = plan.problems.length + outcome.skipped;

  el.report.className = 'report';
  el.report.replaceChildren(
    reportLine(`${fileName} — ${source}, ${numbers.format(plan.total)} rekordów w pliku.`),
    reportLine(
      `Dodano ${numbers.format(outcome.added)} nowych pozycji, scalono ${numbers.format(outcome.merged)} istniejących.`,
    ),
    reportLine(
      `Treści: ${numbers.format(outcome.contents)}, podświetlenia: ${numbers.format(outcome.highlights)}.`,
    ),
  );

  if (skipped === 0) {
    el.report.append(reportLine('Nic nie zostało pominięte.'));
  } else {
    el.report.append(reportLine(`Pominięto ${numbers.format(skipped)} rekordów:`));

    const list = element('ul', 'report__problems');
    for (const group of summarizeProblems(plan.problems)) {
      list.append(
        element(
          'li',
          '',
          `${group.reason} — ${numbers.format(group.count)} (${group.examples.join(', ')})`,
        ),
      );
    }
    // Baza pomija też to, czego plik nie mógł wiedzieć: treść, którą już mamy,
    // i zaznaczenia identyczne z zapisanymi.
    if (outcome.skipped > 0) {
      list.append(
        element(
          'li',
          '',
          `treści i zaznaczenia, które już były w bazie — ${numbers.format(outcome.skipped)}`,
        ),
      );
    }
    el.report.append(list);
  }

  el.report.hidden = false;
}

async function importFile(file: File): Promise<void> {
  let plan: ImportPlan;
  try {
    plan = parseImportFile(file.name, await file.text());
  } catch (error) {
    renderImportError(
      error instanceof ImportError ? error.message : 'pliku nie udało się odczytać.',
    );
    return;
  }

  if (plan.dump.items.length === 0) {
    renderImportError('nie ma w nim ani jednej pozycji nadającej się do zapisania.');
    return;
  }

  // Wszystko albo nic: `importDump` robi jedną transakcję, więc błąd w połowie
  // nie zostawia bazy w połowie zaimportowanej.
  const outcome = await importDump(plan.dump);
  renderReport(file.name, plan, outcome);
  toast(`Zaimportowano ${numbers.format(outcome.added + outcome.merged)} pozycji.`);
  await refresh();
}

// ---------------------------------------------------------------------------
// Synchronizacja
// ---------------------------------------------------------------------------

function selectedProvider(): SyncProvider | null {
  return getProvider(el.syncProvider?.value ?? null) ?? null;
}

function syncStatusLine(
  lastSyncAt: number | null,
  lastError: string | null,
  report: { added: number; updated: number; deleted: number; pushed: number; conflicts: number } | null,
): string {
  if (lastError !== null) return `Ostatnia próba nie powiodła się: ${lastError}`;
  if (lastSyncAt === null) return 'Jeszcze nie synchronizowano.';
  if (report === null) return `Ostatnia synchronizacja: ${formatWhen(lastSyncAt)}.`;

  const conflicts =
    report.conflicts === 0
      ? ''
      : ` Rozstrzygnięto ${numbers.format(report.conflicts)} konfliktów po dacie zmiany.`;

  return `Ostatnio ${formatWhen(lastSyncAt)}: pobrano ${numbers.format(report.added)} nowych, zaktualizowano ${numbers.format(report.updated)}, usunięto ${numbers.format(report.deleted)}, wysłano ${numbers.format(report.pushed)} pozycji.${conflicts}`;
}

async function renderSync(): Promise<void> {
  const select = el.syncProvider;
  if (select === null) return;

  if (select.options.length === 0) {
    for (const provider of listProviders()) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      select.append(option);
    }
  }

  const state = await loadSyncState();
  if (state.providerId !== null && getProvider(state.providerId) !== undefined) {
    select.value = state.providerId;
  }

  const provider = selectedProvider();
  if (provider === null) return;

  // Informacja o tym, gdzie lądują dane, musi być na wierzchu ZANIM ktoś wklei
  // token - nie w pomocy, nie po kliknięciu.
  if (el.syncLocation !== null) el.syncLocation.textContent = provider.dataLocation;
  if (el.syncSecretLabel !== null) el.syncSecretLabel.textContent = provider.prompt.label;
  if (el.syncHelp !== null) el.syncHelp.textContent = provider.prompt.help;

  if (el.syncSecret !== null) {
    el.syncSecret.placeholder = provider.prompt.placeholder ?? '';
    // Provider typu `picker` (np. folder lokalny) nie ma czego wklejać -
    // zostaje sam przycisk.
    const field = el.syncSecret.closest('label');
    if (field !== null) field.hidden = provider.prompt.kind !== 'secret';
  }
  if (el.syncAuthorize !== null) {
    el.syncAuthorize.textContent = provider.prompt.kind === 'secret' ? 'Połącz' : 'Wybierz miejsce';
  }

  const connected = await provider.isConnected();
  if (el.syncConnect !== null) el.syncConnect.hidden = connected;
  if (el.syncConnected !== null) el.syncConnected.hidden = !connected;
  if (!connected) return;

  if (el.syncTarget !== null) {
    el.syncTarget.textContent = `Miejsce docelowe: ${(await provider.describe()) ?? 'nieznane'}`;
  }
  if (el.syncAuto !== null) el.syncAuto.checked = state.auto;
  if (el.syncStatus !== null) {
    el.syncStatus.textContent = syncStatusLine(state.lastSyncAt, state.lastError, state.lastReport);
  }
}

/**
 * UWAGA na kolejność: `provider.authorize` musi być pierwszym `await` w obsłudze
 * kliknięcia, bo w środku prosi o uprawnienie do domeny, a Firefox przyjmuje
 * taką prośbę wyłącznie prosto z gestu użytkownika (CLAUDE.md 5.3).
 */
function onAuthorize(): void {
  const provider = selectedProvider();
  if (provider === null) return;
  const secret = el.syncSecret?.value ?? '';

  void provider.authorize(secret).then(
    async () => {
      if (el.syncSecret !== null) el.syncSecret.value = '';
      await saveSyncState({ providerId: provider.id, lastError: null });
      await renderSync();
      toast('Połączono. Pierwsza synchronizacja wyśle to, co masz lokalnie.');
    },
    async (error: unknown) => {
      toast(error instanceof Error ? error.message : 'Nie udało się połączyć.');
      await renderSync();
    },
  );
}

async function runSync(): Promise<void> {
  const provider = selectedProvider();
  if (provider === null) return;

  if (el.syncNow !== null) {
    el.syncNow.disabled = true;
    el.syncNow.textContent = 'Synchronizuję…';
  }

  try {
    const report = await syncNow(provider);
    toast(
      `Zsynchronizowano: ${numbers.format(report.added)} nowych, ${numbers.format(report.updated)} zaktualizowanych, ${numbers.format(report.pushed)} wysłanych.`,
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Synchronizacja nie powiodła się.');
  } finally {
    if (el.syncNow !== null) {
      el.syncNow.disabled = false;
      el.syncNow.textContent = 'Synchronizuj teraz';
    }
    await refresh();
  }
}

async function disconnectSync(): Promise<void> {
  const provider = selectedProvider();
  if (provider === null) return;

  const ok = await ask(
    'Rozłączyć?',
    'Usuniemy z tego urządzenia dostęp do miejsca synchronizacji (token zostanie skasowany). Dane po drugiej stronie i te lokalne zostają nietknięte.',
  );
  if (!ok) return;

  await provider.disconnect();
  await applyAutoSync(false);
  await saveSyncState({ providerId: null, auto: false, revision: null, lastReport: null, lastError: null });
  await renderSync();
  toast('Rozłączono.');
}

async function toggleAutoSync(auto: boolean): Promise<void> {
  await saveSyncState({ auto });
  await applyAutoSync(auto);
  toast(auto ? `Automat co ${String(SYNC_INTERVAL_MINUTES)} minut włączony.` : 'Automat wyłączony.');
}

// ---------------------------------------------------------------------------
// Kopie automatyczne
// ---------------------------------------------------------------------------

function formatWhen(createdAt: number): string {
  return new Date(createdAt).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
}

async function renderSnapshots(): Promise<void> {
  if (el.snapshots === null) return;

  const snapshots = await listSnapshots();
  if (snapshots.length === 0) {
    el.snapshots.replaceChildren(
      element('li', 'muted', 'Jeszcze nie ma żadnej kopii — pierwsza powstanie w ciągu doby.'),
    );
    return;
  }

  el.snapshots.replaceChildren(
    ...snapshots.map((snapshot) => {
      const row = element('li', 'snapshot');

      const meta = element('div', 'snapshot__meta');
      meta.append(
        element('span', 'snapshot__when', formatWhen(snapshot.createdAt)),
        element('span', 'snapshot__count', `${numbers.format(snapshot.itemCount)} pozycji`),
      );

      const button = element('button', 'button button--ghost', 'Przywróć');
      button.type = 'button';
      button.addEventListener('click', () => {
        void restoreFromSnapshot(snapshot.id, snapshot.createdAt);
      });

      row.append(meta, button);
      return row;
    }),
  );
}

async function restoreFromSnapshot(id: string, createdAt: number): Promise<void> {
  const ok = await ask(
    'Przywrócić kopię?',
    `Kopia z ${formatWhen(createdAt)} dołoży brakujące pozycje i uzupełni istniejące. Nic nie zostanie skasowane ani odarchiwizowane.`,
  );
  if (!ok) return;

  const outcome = await restoreSnapshot(id);
  toast(
    `Przywrócono: ${numbers.format(outcome.added)} pozycji z powrotem, ${numbers.format(outcome.merged)} uzupełnionych.`,
  );
  await refresh();
}

async function snapshotNow(): Promise<void> {
  const snapshot = await createSnapshot();
  toast(`Zapisano kopię: ${numbers.format(snapshot.itemCount)} pozycji.`);
  await renderSnapshots();
}

// ---------------------------------------------------------------------------
// Potwierdzenie i kasowanie
// ---------------------------------------------------------------------------

/**
 * Potwierdzenie w `<dialog>`, nie przez `confirm()` - natywny modal blokuje
 * cały wątek strony rozszerzenia i wygląda inaczej na każdym systemie.
 */
function ask(title: string, message: string): Promise<boolean> {
  const dialog = el.dialog;
  if (dialog === null || el.dialogOk === null || el.dialogCancel === null) {
    return Promise.resolve(false);
  }

  if (el.dialogTitle !== null) el.dialogTitle.textContent = title;
  if (el.dialogText !== null) el.dialogText.textContent = message;

  return new Promise<boolean>((resolve) => {
    const controller = new AbortController();
    const finish = (value: boolean): void => {
      controller.abort();
      dialog.close();
      resolve(value);
    };

    el.dialogOk?.addEventListener('click', () => {
      finish(true);
    }, { signal: controller.signal });
    el.dialogCancel?.addEventListener('click', () => {
      finish(false);
    }, { signal: controller.signal });
    // Esc zamyka okno bez klikania - to też jest "nie".
    dialog.addEventListener('close', () => {
      finish(false);
    }, { signal: controller.signal });

    dialog.showModal();
  });
}

async function wipe(): Promise<void> {
  const stats = await dataStats();
  const ok = await ask(
    'Usunąć wszystkie dane?',
    `Znikną ${numbers.format(stats.items)} pozycji, ${numbers.format(stats.contents)} zapisanych treści, ${numbers.format(stats.highlights)} podświetleń i wszystkie kopie automatyczne. Tego nie da się cofnąć.`,
  );
  if (!ok) return;

  await clearAllData();
  toast('Baza wyczyszczona.');
  await refresh();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  await renderStats();
  await renderSync();
  await renderSnapshots();
  await renderStorage();
}

function wire(): void {
  el.openList?.addEventListener('click', () => {
    void browser.tabs.create({ url: browser.runtime.getURL('ui/list/list.html?full=1') });
  });

  el.exportJson?.addEventListener('click', () => {
    void exportJson().catch((error: unknown) => {
      console.error('[savely] eksport JSON nie powiódł się:', error);
      toast('Nie udało się przygotować kopii.');
    });
  });

  el.exportHtml?.addEventListener('click', () => {
    void exportBookmarks().catch((error: unknown) => {
      console.error('[savely] eksport zakładek nie powiódł się:', error);
      toast('Nie udało się przygotować zakładek.');
    });
  });

  el.importFile?.addEventListener('change', () => {
    const file = el.importFile?.files?.[0];
    if (file === undefined) return;

    void importFile(file)
      .catch((error: unknown) => {
        console.error('[savely] import nie powiódł się:', error);
        renderImportError('zapis do bazy nie powiódł się, baza została bez zmian.');
      })
      .finally(() => {
        // Bez tego wybranie tego samego pliku drugi raz nie odpali `change`.
        if (el.importFile !== null) el.importFile.value = '';
      });
  });

  el.syncProvider?.addEventListener('change', () => {
    void renderSync();
  });
  el.syncAuthorize?.addEventListener('click', onAuthorize);
  el.syncNow?.addEventListener('click', () => {
    void runSync();
  });
  el.syncDisconnect?.addEventListener('click', () => {
    void disconnectSync();
  });
  el.syncAuto?.addEventListener('change', () => {
    void toggleAutoSync(el.syncAuto?.checked ?? false);
  });

  el.snapshotNow?.addEventListener('click', () => {
    void snapshotNow();
  });

  el.wipe?.addEventListener('click', () => {
    void wipe();
  });
}

async function main(): Promise<void> {
  wire();
  if (el.snapshotNow !== null) {
    el.snapshotNow.title = `Trzymamy ${String(SNAPSHOT_LIMIT)} ostatnie kopie.`;
  }
  await refresh();
}

void main();
