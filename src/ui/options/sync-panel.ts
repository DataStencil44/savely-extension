import {
  SYNC_INTERVAL_MINUTES,
  applyAutoSync,
  disconnectSync,
  getProvider,
  listProviders,
  loadSyncState,
  saveSyncState,
  syncNow,
  type SyncProvider,
  type SyncReport,
} from '@/lib/sync';
import { required } from '@/ui/shared/dom';

import { formatWhen, numbers, type Page, type Section } from './page';

function syncStatusLine(
  lastSyncAt: number | null,
  lastError: string | null,
  report: SyncReport | null,
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

export function mountSync(page: Page): Section {
  const el = {
    provider: required<HTMLSelectElement>('#sync-provider'),
    location: required<HTMLParagraphElement>('#sync-location'),
    connect: required<HTMLDivElement>('#sync-connect'),
    connected: required<HTMLDivElement>('#sync-connected'),
    secret: required<HTMLInputElement>('#sync-secret'),
    secretLabel: required<HTMLSpanElement>('#sync-secret-label'),
    help: required<HTMLParagraphElement>('#sync-help'),
    authorize: required<HTMLButtonElement>('#sync-authorize'),
    target: required<HTMLParagraphElement>('#sync-target'),
    status: required<HTMLParagraphElement>('#sync-status'),
    now: required<HTMLButtonElement>('#sync-now'),
    disconnect: required<HTMLButtonElement>('#sync-disconnect'),
    auto: required<HTMLInputElement>('#sync-auto'),
  };

  function selectedProvider(): SyncProvider | null {
    return getProvider(el.provider.value) ?? null;
  }

  async function render(): Promise<void> {
    const select = el.provider;

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

    el.location.textContent = provider.dataLocation;
    el.secretLabel.textContent = provider.prompt.label;
    el.help.textContent = provider.prompt.help;

    el.secret.placeholder = provider.prompt.placeholder ?? '';
    const field = el.secret.closest('label');
    if (field !== null) field.hidden = provider.prompt.kind !== 'secret';

    el.authorize.textContent = provider.prompt.kind === 'secret' ? 'Connect' : 'Choose a location';

    const connected = await provider.isConnected();
    el.connect.hidden = connected;
    el.connected.hidden = !connected;
    if (!connected) return;

    el.target.textContent = `Destination: ${(await provider.describe()) ?? 'unknown'}`;
    el.auto.checked = state.auto;
    el.status.textContent = syncStatusLine(state.lastSyncAt, state.lastError, state.lastReport);
  }

  function onAuthorize(): void {
    const provider = selectedProvider();
    if (provider === null) return;
    const secret = el.secret.value;

    void provider.authorize(secret).then(
      async () => {
        el.secret.value = '';
        await saveSyncState({ providerId: provider.id, lastError: null });
        await render();
        page.toast('Connected. The first sync will push what you have locally.');
      },
      async (error: unknown) => {
        page.toast(error instanceof Error ? error.message : 'Could not connect.');
        await render();
      },
    );
  }

  async function runSync(): Promise<void> {
    const provider = selectedProvider();
    if (provider === null) return;

    el.now.disabled = true;
    el.now.textContent = 'Syncing…';

    try {
      const report = await syncNow(provider);
      page.toast(
        `Synced: ${numbers.format(report.added)} new, ${numbers.format(report.updated)} updated, ${numbers.format(report.pushed)} pushed.`,
      );
    } catch (error) {
      page.toast(error instanceof Error ? error.message : 'Sync failed.');
    } finally {
      el.now.disabled = false;
      el.now.textContent = 'Sync now';
      await page.refresh();
    }
  }

  async function onDisconnect(): Promise<void> {
    const provider = selectedProvider();
    if (provider === null) return;

    const ok = await page.ask(
      'Disconnect?',
      'We will remove this device’s access to the sync location (the token will be erased). The data on the other side and your local data stay untouched.',
    );
    if (!ok) return;

    await disconnectSync(provider);
    await render();
    page.toast('Disconnected.');
  }

  async function toggleAutoSync(auto: boolean): Promise<void> {
    await saveSyncState({ auto });
    await applyAutoSync(auto);
    page.toast(
      auto ? `Automatic sync every ${String(SYNC_INTERVAL_MINUTES)} minutes is on.` : 'Automatic sync is off.',
    );
  }

  el.provider.addEventListener('change', () => {
    void render();
  });
  el.authorize.addEventListener('click', onAuthorize);
  el.now.addEventListener('click', () => {
    void runSync();
  });
  el.disconnect.addEventListener('click', () => {
    void onDisconnect();
  });
  el.auto.addEventListener('change', () => {
    void toggleAutoSync(el.auto.checked);
  });

  return { refresh: render };
}
