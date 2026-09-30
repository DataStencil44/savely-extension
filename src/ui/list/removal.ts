import { deleteItem, restoreItem, type RemovedItem } from '@/lib/library';
import type { SavedItem } from '@/types/item';
import { showToast } from '@/ui/shared/toast';

import type { ListStore } from './store';

const UNDO_MS = 5_000;

interface PendingDelete {
  item: SavedItem;
  removed: Promise<RemovedItem | null>;
}

export function createRemoval(store: ListStore, toastHost: HTMLElement): (item: SavedItem) => void {
  const pending = new Map<string, PendingDelete>();

  async function undo(id: string): Promise<void> {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);

    const removed = await entry.removed;
    if (removed !== null) await restoreItem(removed);

    store.restore(entry.item);
  }

  return (item) => {
    store.remove(item.id);

    const removed = deleteItem(item.id).catch((error: unknown) => {
      console.error('[savely] the deletion did not reach the database:', error);
      return null;
    });
    pending.set(item.id, { item, removed });

    showToast(toastHost, {
      message: `Deleted “${item.title === '' ? item.url : item.title}”`,
      durationMs: UNDO_MS,
      action: {
        label: 'Undo',
        run: () => {
          void undo(item.id);
        },
      },
      onExpire: () => {
        pending.delete(item.id);
      },
    });
  };
}
