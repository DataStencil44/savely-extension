import { dataStats } from '@/lib/library';
import { element, required } from '@/ui/shared/dom';

import { numbers, type Section } from './page';

function statTile(value: number, label: string): HTMLDivElement {
  const tile = element('div', 'stat');
  tile.append(
    element('p', 'stat__value', numbers.format(value)),
    element('p', 'stat__label', label),
  );
  return tile;
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

export function mountStats(): Section {
  const stats = required<HTMLDListElement>('#stats');
  const storage = required<HTMLParagraphElement>('#storage');

  async function renderStats(): Promise<void> {
    const counts = await dataStats();

    stats.replaceChildren(
      statTile(counts.items, 'items'),
      statTile(counts.unread, 'to read'),
      statTile(counts.archived, 'archived'),
      statTile(counts.favorite, 'favorites'),
      statTile(counts.contents, 'with offline content'),
      statTile(counts.highlights, 'highlights'),
    );
  }

  async function renderStorage(): Promise<void> {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage === undefined) {
      storage.textContent = 'The browser does not report storage usage.';
      return;
    }

    const used = formatBytes(estimate.usage);
    if (estimate.quota === undefined || estimate.quota === 0) {
      storage.textContent = `Storage used: ${used}.`;
      return;
    }

    const percent = ((estimate.usage / estimate.quota) * 100).toFixed(1);
    storage.textContent = `Storage used: ${used} of ${formatBytes(estimate.quota)} (${percent}%).`;
  }

  return {
    async refresh() {
      await renderStats();
      await renderStorage();
    },
  };
}
