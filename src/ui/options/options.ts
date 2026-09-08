/**
 * The options page: everything that moves data in one place.
 *
 * With no backend this is the only way data gets in and out, so every operation
 * has to be understandable and reversible: an export changes nothing, an import
 * only adds, automatic backups live in the database, and the one irreversible
 * action (wiping) requires confirmation in a dialog.
 *
 * File parsing and validation live in `src/lib/backup.ts`, writing in
 * `src/lib/db.ts` - what stays here is the view and the report of what happened.
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
import { type Theme } from '@/lib/settings';
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
import { initTheme, setTheme } from '@/lib/theme';
import { showToast } from '@/ui/list/toast';

/** The blob has to outlive the start of the download - the browser copies it asynchronously. */
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
  themes: [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')],
  toast: document.querySelector<HTMLDivElement>('#toast'),
  dialog: document.querySelector<HTMLDialogElement>('#confirm-dialog'),
  dialogTitle: document.querySelector<HTMLHeadingElement>('#confirm-title'),
  dialogText: document.querySelector<HTMLParagraphElement>('#confirm-text'),
  dialogOk: document.querySelector<HTMLButtonElement>('#confirm-ok'),
  dialogCancel: document.querySelector<HTMLButtonElement>('#confirm-cancel'),
};

const numbers = new Intl.NumberFormat('en-US');

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
// Counters and storage
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
    statTile(stats.items, 'items'),
    statTile(stats.unread, 'to read'),
    statTile(stats.archived, 'archived'),
    statTile(stats.favorite, 'favorites'),
    statTile(stats.contents, 'with offline content'),
    statTile(stats.highlights, 'highlights'),
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
  return `${value.toFixed(digits)} ${units[unit] ?? 'B'}`;
}

/**
 * `navigator.storage.estimate()` reports usage for the whole extension origin,
 * not just the database, and rounds the result - treat it as an order of
 * magnitude. On older engines (Firefox for Android) it may be missing entirely.
 */
async function renderStorage(): Promise<void> {
  if (el.storage === null) return;

  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.usage === undefined) {
    el.storage.textContent = 'The browser does not report storage usage.';
    return;
  }

  const used = formatBytes(estimate.usage);
  if (estimate.quota === undefined || estimate.quota === 0) {
    el.storage.textContent = `Storage used: ${used}.`;
    return;
  }

  const percent = ((estimate.usage / estimate.quota) * 100).toFixed(1);
  el.storage.textContent = `Storage used: ${used} of ${formatBytes(estimate.quota)} (${percent}%).`;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Downloading through the `downloads` API - it behaves the same on both engines
 * and lets us suggest a file name. If the permission is missing, a plain link
 * remains: better to download the file some other way than not at all.
 */
async function downloadFile(content: string, fileName: string, mime: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));

  try {
    await browser.downloads.download({ url, filename: fileName, saveAs: true });
  } catch (error) {
    console.warn('[savely] downloads API unavailable, falling back to a link:', error);
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
  toast(`Backup ready: ${numbers.format(dump.items.length)} items.`);
}

async function exportBookmarks(): Promise<void> {
  const now = Date.now();
  const items = await listAllItems();
  await downloadFile(buildBookmarksHtml(items, now), bookmarksFileName(now), 'text/html');
  toast(`Bookmarks ready: ${numbers.format(items.length)} items.`);
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
  el.report.replaceChildren(reportLine(`Nothing was imported: ${message}`));
  el.report.hidden = false;
}

function renderReport(fileName: string, plan: ImportPlan, outcome: MergeOutcome): void {
  if (el.report === null) return;

  const source = plan.source === 'json' ? 'a Savely backup' : 'a Pocket export';
  const skipped = plan.problems.length + outcome.skipped;

  el.report.className = 'report';
  el.report.replaceChildren(
    reportLine(`${fileName} \u2014 ${source}, ${numbers.format(plan.total)} records in the file.`),
    reportLine(
      `Added ${numbers.format(outcome.added)} new items, merged ${numbers.format(outcome.merged)} existing ones.`,
    ),
    reportLine(
      `Content: ${numbers.format(outcome.contents)}, highlights: ${numbers.format(outcome.highlights)}.`,
    ),
  );

  if (skipped === 0) {
    el.report.append(reportLine('Nothing was skipped.'));
  } else {
    el.report.append(reportLine(`Skipped ${numbers.format(skipped)} records:`));

    const list = element('ul', 'report__problems');
    for (const group of summarizeProblems(plan.problems)) {
      list.append(
        element(
          'li',
          '',
          `${group.reason} \u2014 ${numbers.format(group.count)} (${group.examples.join(', ')})`,
        ),
      );
    }
    // The database also skips what the file could not know about: content we
    // already have, and highlights identical to the stored ones.
    if (outcome.skipped > 0) {
      list.append(
        element(
          'li',
          '',
          `content and highlights already in the database \u2014 ${numbers.format(outcome.skipped)}`,
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
      error instanceof ImportError ? error.message : 'the file could not be read.',
    );
    return;
  }

  if (plan.dump.items.length === 0) {
    renderImportError('it contains no item that could be saved.');
    return;
  }

  // All or nothing: `importDump` runs a single transaction, so a failure
  // halfway through does not leave the database half-imported.
  const outcome = await importDump(plan.dump);
  renderReport(file.name, plan, outcome);
  toast(`Imported ${numbers.format(outcome.added + outcome.merged)} items.`);
  await refresh();
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function selectedProvider(): SyncProvider | null {
  return getProvider(el.syncProvider?.value ?? null) ?? null;
}

function syncStatusLine(
  lastSyncAt: number | null,
  lastError: string | null,
  report: { added: number; updated: number; deleted: number; pushed: number; conflicts: number } | null,
): string {
  if (lastError !== null) return `The last attempt failed: ${lastError}`;
  if (lastSyncAt === null) return 'Not synced yet.';
  if (report === null) return `Last sync: ${formatWhen(lastSyncAt)}.`;

  const conflicts =
    report.conflicts === 0
      ? ''
      : ` Resolved ${numbers.format(report.conflicts)} conflict(s) by change date.`;

  return `Last run ${formatWhen(lastSyncAt)}: pulled ${numbers.format(report.added)} new, updated ${numbers.format(report.updated)}, deleted ${numbers.format(report.deleted)}, pushed ${numbers.format(report.pushed)} items.${conflicts}`;
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

  // Where the data ends up has to be visible BEFORE anyone pastes a token -
  // not in a help page, not behind a click.
  if (el.syncLocation !== null) el.syncLocation.textContent = provider.dataLocation;
  if (el.syncSecretLabel !== null) el.syncSecretLabel.textContent = provider.prompt.label;
  if (el.syncHelp !== null) el.syncHelp.textContent = provider.prompt.help;

  if (el.syncSecret !== null) {
    el.syncSecret.placeholder = provider.prompt.placeholder ?? '';
    // A `picker` provider (a local folder, say) has nothing to paste - only
    // the button remains.
    const field = el.syncSecret.closest('label');
    if (field !== null) field.hidden = provider.prompt.kind !== 'secret';
  }
  if (el.syncAuthorize !== null) {
    el.syncAuthorize.textContent = provider.prompt.kind === 'secret' ? 'Connect' : 'Choose a location';
  }

  const connected = await provider.isConnected();
  if (el.syncConnect !== null) el.syncConnect.hidden = connected;
  if (el.syncConnected !== null) el.syncConnected.hidden = !connected;
  if (!connected) return;

  if (el.syncTarget !== null) {
    el.syncTarget.textContent = `Destination: ${(await provider.describe()) ?? 'unknown'}`;
  }
  if (el.syncAuto !== null) el.syncAuto.checked = state.auto;
  if (el.syncStatus !== null) {
    el.syncStatus.textContent = syncStatusLine(state.lastSyncAt, state.lastError, state.lastReport);
  }
}

/**
 * MIND THE ORDER: `provider.authorize` must be the first `await` in the click
 * handler, because inside it asks for a host permission, and Firefox accepts
 * such a request only straight from a user gesture (CLAUDE.md 5.3).
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
      toast('Connected. The first sync will push what you have locally.');
    },
    async (error: unknown) => {
      toast(error instanceof Error ? error.message : 'Could not connect.');
      await renderSync();
    },
  );
}

async function runSync(): Promise<void> {
  const provider = selectedProvider();
  if (provider === null) return;

  if (el.syncNow !== null) {
    el.syncNow.disabled = true;
    el.syncNow.textContent = 'Syncing\u2026';
  }

  try {
    const report = await syncNow(provider);
    toast(
      `Synced: ${numbers.format(report.added)} new, ${numbers.format(report.updated)} updated, ${numbers.format(report.pushed)} pushed.`,
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Sync failed.');
  } finally {
    if (el.syncNow !== null) {
      el.syncNow.disabled = false;
      el.syncNow.textContent = 'Sync now';
    }
    await refresh();
  }
}

async function disconnectSync(): Promise<void> {
  const provider = selectedProvider();
  if (provider === null) return;

  const ok = await ask(
    'Disconnect?',
    'We will remove this device\u2019s access to the sync location (the token will be erased). The data on the other side and your local data stay untouched.',
  );
  if (!ok) return;

  await provider.disconnect();
  await applyAutoSync(false);
  await saveSyncState({ providerId: null, auto: false, revision: null, lastReport: null, lastError: null });
  await renderSync();
  toast('Disconnected.');
}

async function toggleAutoSync(auto: boolean): Promise<void> {
  await saveSyncState({ auto });
  await applyAutoSync(auto);
  toast(auto ? `Automatic sync every ${String(SYNC_INTERVAL_MINUTES)} minutes is on.` : 'Automatic sync is off.');
}

// ---------------------------------------------------------------------------
// Automatic backups
// ---------------------------------------------------------------------------

function formatWhen(createdAt: number): string {
  return new Date(createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

async function renderSnapshots(): Promise<void> {
  if (el.snapshots === null) return;

  const snapshots = await listSnapshots();
  if (snapshots.length === 0) {
    el.snapshots.replaceChildren(
      element('li', 'muted', 'No backup yet \u2014 the first one will be made within a day.'),
    );
    return;
  }

  el.snapshots.replaceChildren(
    ...snapshots.map((snapshot) => {
      const row = element('li', 'snapshot');

      const meta = element('div', 'snapshot__meta');
      meta.append(
        element('span', 'snapshot__when', formatWhen(snapshot.createdAt)),
        element('span', 'snapshot__count', `${numbers.format(snapshot.itemCount)} items`),
      );

      const button = element('button', 'button button--ghost', 'Restore');
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
    'Restore this backup?',
    `The backup from ${formatWhen(createdAt)} will add missing items and fill in existing ones. Nothing will be deleted or un-archived.`,
  );
  if (!ok) return;

  const outcome = await restoreSnapshot(id);
  toast(
    `Restored: ${numbers.format(outcome.added)} items brought back, ${numbers.format(outcome.merged)} filled in.`,
  );
  await refresh();
}

async function snapshotNow(): Promise<void> {
  const snapshot = await createSnapshot();
  toast(`Backup saved: ${numbers.format(snapshot.itemCount)} items.`);
  await renderSnapshots();
}

// ---------------------------------------------------------------------------
// Confirmation and wiping
// ---------------------------------------------------------------------------

/**
 * Confirmation in a `<dialog>`, not via `confirm()` - the native modal blocks
 * the whole extension page thread and looks different on every system.
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
    // Esc closes the dialog without a click - that is a "no" as well.
    dialog.addEventListener('close', () => {
      finish(false);
    }, { signal: controller.signal });

    dialog.showModal();
  });
}

async function wipe(): Promise<void> {
  const stats = await dataStats();
  const ok = await ask(
    'Delete all data?',
    `${numbers.format(stats.items)} items, ${numbers.format(stats.contents)} stored articles, ${numbers.format(stats.highlights)} highlights and every automatic backup will be gone. This cannot be undone.`,
  );
  if (!ok) return;

  await clearAllData();
  toast('The database has been cleared.');
  await refresh();
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/**
 * Four buttons rather than the list's one-button cycle: here there is room, and
 * a settings page should show what the options are, not make you click through
 * them. Both switches write the same setting.
 */
function showTheme(theme: Theme): void {
  for (const button of el.themes) {
    button.setAttribute('aria-pressed', String(button.dataset['themeChoice'] === theme));
  }
}

function wireThemes(): void {
  for (const button of el.themes) {
    button.addEventListener('click', () => {
      const choice = button.dataset['themeChoice'] as Theme | undefined;
      if (choice === undefined) return;
      showTheme(choice);
      void setTheme(choice);
    });
  }
}

// ---------------------------------------------------------------------------
// Startup
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
      console.error('[savely] JSON export failed:', error);
      toast('Could not prepare the backup.');
    });
  });

  el.exportHtml?.addEventListener('click', () => {
    void exportBookmarks().catch((error: unknown) => {
      console.error('[savely] bookmarks export failed:', error);
      toast('Could not prepare the bookmarks.');
    });
  });

  el.importFile?.addEventListener('change', () => {
    const file = el.importFile?.files?.[0];
    if (file === undefined) return;

    void importFile(file)
      .catch((error: unknown) => {
        console.error('[savely] import failed:', error);
        renderImportError('writing to the database failed, the database is unchanged.');
      })
      .finally(() => {
        // Without this, picking the same file twice would not fire `change`.
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

  wireThemes();
}

async function main(): Promise<void> {
  wire();
  // Not awaited: reading the counters is the slow part of this page, and the
  // theme must not queue behind it.
  void initTheme(showTheme);
  if (el.snapshotNow !== null) {
    el.snapshotNow.title = `We keep the last ${String(SNAPSHOT_LIMIT)} backups.`;
  }
  await refresh();
}

void main();
