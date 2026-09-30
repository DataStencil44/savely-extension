import { SNAPSHOT_LIMIT, createSnapshot, listSnapshots, restoreSnapshot } from '@/lib/library';
import { element, required } from '@/ui/shared/dom';

import { formatWhen, numbers, type Page, type Section } from './page';

export function mountBackups(page: Page): Section {
  const list = required<HTMLUListElement>('#snapshots');
  const snapshotNowButton = required<HTMLButtonElement>('#snapshot-now');

  async function render(): Promise<void> {
    const snapshots = await listSnapshots();
    if (snapshots.length === 0) {
      list.replaceChildren(
        element('li', 'muted', 'No backup yet — the first one will be made within a day.'),
      );
      return;
    }

    list.replaceChildren(
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
    const ok = await page.ask(
      'Restore this backup?',
      `The backup from ${formatWhen(createdAt)} will add missing items and fill in existing ones. Nothing will be deleted or un-archived.`,
    );
    if (!ok) return;

    const outcome = await restoreSnapshot(id);
    page.toast(
      `Restored: ${numbers.format(outcome.added)} items brought back, ${numbers.format(outcome.merged)} filled in.`,
    );
    await page.refresh();
  }

  async function snapshotNow(): Promise<void> {
    const snapshot = await createSnapshot();
    page.toast(`Backup saved: ${numbers.format(snapshot.itemCount)} items.`);
    await render();
  }

  snapshotNowButton.title = `We keep the last ${String(SNAPSHOT_LIMIT)} backups.`;
  snapshotNowButton.addEventListener('click', () => {
    void snapshotNow();
  });

  return { refresh: render };
}
