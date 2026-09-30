import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteSnapshot, SyncFiles, SyncProvider } from './types';

vi.hoisted(() => {
  const local: Record<string, unknown> = {};
  const noop = (): void => undefined;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { id: 'test', getURL: (path: string) => path, lastError: null },
      storage: {
        local: {
          get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            callback(key !== undefined && key in local ? { [key]: local[key] } : {});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(local, items);
            callback();
          },
          remove: (key: string, callback: () => void) => {
            delete local[key];
            callback();
          },
        },
        onChanged: { addListener: noop },
      },
      alarms: {
        create: (_name: string, _options: unknown, callback?: () => void) => callback?.(),
        clear: (_name: string, callback?: (was: boolean) => void) => callback?.(true),
      },
    },
  });
});

const {
  addHighlight,
  deleteDb,
  deleteHighlight,
  deleteItem,
  getContent,
  getItemByUrl,
  listHighlights,
  saveItem,
  setContent,
  updateItem,
} = await import('../db');
const { parseSyncState, syncNow } = await import('./engine');
const { METADATA_FILE } = await import('./types');

class MemoryProvider implements SyncProvider {
  readonly id = 'memory';
  readonly label = 'Memory';
  readonly dataLocation = 'Nowhere - this is a test.';
  readonly prompt = { kind: 'picker' as const, label: 'Location', help: '' };

  files: SyncFiles | null = null;
  revision: string | null = null;
  pushes = 0;

  authorize(): Promise<void> {
    return Promise.resolve();
  }
  isConnected(): Promise<boolean> {
    return Promise.resolve(true);
  }
  describe(): Promise<string | null> {
    return Promise.resolve('memory');
  }
  pull(): Promise<RemoteSnapshot> {
    return Promise.resolve({ files: this.files, revision: this.revision });
  }
  push(files: SyncFiles, expectedRevision: string | null): Promise<string> {
    if (expectedRevision !== this.revision) {
      throw new Error('the revision diverged');
    }
    this.files = files;
    this.pushes += 1;
    this.revision = `rev-${String(this.pushes)}`;
    return Promise.resolve(this.revision);
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
}

const URL_A = 'https://a.example/article';

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('a full pass', () => {
  it('pushes the local state and the second device receives all of it', async () => {
    const provider = new MemoryProvider();

    const item = await saveItem({ url: URL_A, title: 'An article', tags: ['rust'] });
    await setContent(item.id, { html: '<p>content</p>', text: 'content' });
    await addHighlight({ itemId: item.id, text: 'a quote', start: 0, end: 7, note: 'important' });

    const first = await syncNow(provider);
    expect(first.pushed).toBe(1);
    expect(first.added).toBe(0);
    expect(provider.files?.[METADATA_FILE]).toContain('"title": "An article"');

    await deleteDb();
    const second = await syncNow(provider);

    expect(second.added).toBe(1);
    expect(second.contents).toBe(1);
    expect(second.highlights).toBe(1);

    const restored = await getItemByUrl(URL_A);
    expect(restored?.title).toBe('An article');
    expect(restored?.tags).toEqual(['rust']);
    expect((await getContent(restored?.id ?? ''))?.html).toBe('<p>content</p>');
    expect((await listHighlights(restored?.id ?? ''))[0]?.note).toBe('important');
  });

  it('two passes started together run one after the other', async () => {
    const provider = new MemoryProvider();
    await saveItem({ url: URL_A });

    await Promise.all([syncNow(provider), syncNow(provider)]);

    expect(provider.pushes).toBe(2);
    expect(provider.revision).toBe('rev-2');
  });

  it('a second pass with no changes leaves the database alone', async () => {
    const provider = new MemoryProvider();
    await saveItem({ url: URL_A });

    await syncNow(provider);
    const again = await syncNow(provider);

    expect(again).toMatchObject({ added: 0, updated: 0, deleted: 0, contents: 0, highlights: 0 });
  });

  it('a deletion propagates instead of coming back at the next merge', async () => {
    const provider = new MemoryProvider();

    const item = await saveItem({ url: URL_A });
    await syncNow(provider);

    await deleteItem(item.id);
    await syncNow(provider);
    expect(provider.files?.[METADATA_FILE]).toContain('"tombstones"');

    await deleteDb();
    await saveItem({ url: URL_A, savedAt: 1_000 });
    const report = await syncNow(provider);

    expect(report.deleted).toBe(1);
    expect(await getItemByUrl(URL_A)).toBeUndefined();
  });

  it('a change on the second device arrives and wins by date', async () => {
    const provider = new MemoryProvider();

    const item = await saveItem({ url: URL_A, title: 'A title' });
    await syncNow(provider);

    await updateItem(item.id, { favorite: true, tags: ['remote'] });
    await syncNow(provider);

    await deleteDb();
    await saveItem({ url: URL_A, savedAt: 500, tags: ['local'] });

    const report = await syncNow(provider);

    const merged = await getItemByUrl(URL_A);
    expect(report.conflicts).toBe(1);
    expect(merged?.favorite).toBe(true);
    expect(merged?.tags).toEqual(['local', 'remote']);
  });
});

function editRemote(
  provider: MemoryProvider,
  edit: (item: { tags: string[]; updatedAt: number; highlights: unknown[] }) => void,
): void {
  const file = provider.files?.[METADATA_FILE];
  if (provider.files === null || file === undefined) throw new Error('nothing was pushed');
  const metadata = JSON.parse(file) as {
    items: { tags: string[]; updatedAt: number; highlights: unknown[] }[];
  };
  const [item] = metadata.items;
  if (item === undefined) throw new Error('no item on the other side');
  edit(item);
  provider.files = { ...provider.files, [METADATA_FILE]: JSON.stringify(metadata) };
  provider.revision = 'edited-elsewhere';
}

describe('removals', () => {
  it('a tag and a highlight removed here stay removed after the next sync', async () => {
    const provider = new MemoryProvider();
    const item = await saveItem({ url: URL_A, tags: ['rust', 'web'] });
    const highlight = await addHighlight({ itemId: item.id, text: 'a quote', start: 0, end: 7 });
    await syncNow(provider);

    await updateItem(item.id, { tags: ['web'] });
    await deleteHighlight(highlight.id);
    await syncNow(provider);

    expect((await getItemByUrl(URL_A))?.tags).toEqual(['web']);
    expect(await listHighlights(item.id)).toEqual([]);
    expect(provider.files?.[METADATA_FILE]).not.toContain('"rust"');
    expect(provider.files?.[METADATA_FILE]).not.toContain('a quote');
  });

  it('a tag and a highlight removed on another device are removed here', async () => {
    const provider = new MemoryProvider();
    const item = await saveItem({ url: URL_A, tags: ['rust', 'web'] });
    await addHighlight({ itemId: item.id, text: 'a quote', start: 0, end: 7 });
    await syncNow(provider);

    editRemote(provider, (remote) => {
      remote.tags = ['web'];
      remote.highlights = [];
      remote.updatedAt += 1_000;
    });
    await syncNow(provider);

    expect((await getItemByUrl(URL_A))?.tags).toEqual(['web']);
    expect(await listHighlights(item.id)).toEqual([]);
  });

  it('a push that fails leaves the base where it was', async () => {
    const provider = new MemoryProvider();
    const item = await saveItem({ url: URL_A, tags: ['rust'] });
    await syncNow(provider);

    await updateItem(item.id, { tags: ['rust', 'new'] });
    const push = vi.spyOn(provider, 'push').mockRejectedValueOnce(new Error('offline'));
    await expect(syncNow(provider)).rejects.toThrow('offline');
    push.mockRestore();

    await syncNow(provider);
    expect((await getItemByUrl(URL_A))?.tags).toEqual(['new', 'rust']);
  });
});

describe('the stored state', () => {
  it('is nothing until it is something, whatever storage holds', () => {
    expect(parseSyncState(undefined)).toEqual({
      providerId: null,
      auto: false,
      lastSyncAt: null,
      lastError: null,
      revision: null,
      lastReport: null,
    });
    expect(parseSyncState('a string where an object was')).toEqual(parseSyncState(undefined));
  });

  it('reads a report written by this version back unchanged', () => {
    const report = {
      at: 1_700_000_000_000,
      added: 3,
      updated: 2,
      deleted: 1,
      contents: 4,
      highlights: 5,
      pushed: 6,
      conflicts: 0,
    };
    expect(parseSyncState({ providerId: 'memory', auto: true, lastReport: report })).toMatchObject({
      providerId: 'memory',
      auto: true,
      lastReport: report,
    });
  });

  it('never hands the options page a count that is not one', () => {
    const state = parseSyncState({
      lastReport: { added: 'lots', updated: null, deleted: -4, pushed: 2.7 },
    });

    expect(state.lastReport).toEqual({
      at: 0,
      added: 0,
      updated: 0,
      deleted: 0,
      contents: 0,
      highlights: 0,
      pushed: 2,
      conflicts: 0,
    });
  });
});
