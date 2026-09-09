/**
 * An engine test against a real database (fake-indexeddb) and a fake provider
 * that keeps the files in memory - exactly the way a Gist would keep them.
 *
 * The scenario is the one the user cares about: "I saved it on my laptop, will
 * I see it on my phone?". The second device is faked by wiping the database and
 * syncing again - the remote state stays the same.
 */
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

const { addHighlight, deleteDb, deleteItem, getContent, getItemByUrl, listHighlights, saveItem, setContent, updateItem } =
  await import('../db');
const { parseSyncState, syncNow } = await import('./engine');
const { METADATA_FILE } = await import('./types');

/** An in-memory provider: the whole contract and nothing beyond it. */
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

    // --- device A ---
    const item = await saveItem({ url: URL_A, title: 'An article', tags: ['rust'] });
    await setContent(item.id, { html: '<p>content</p>', text: 'content' });
    await addHighlight({ itemId: item.id, text: 'a quote', start: 0, end: 7, note: 'important' });

    const first = await syncNow(provider);
    expect(first.pushed).toBe(1);
    expect(first.added).toBe(0);
    expect(provider.files?.[METADATA_FILE]).toContain('"title": "An article"');

    // --- device B: the same mailbox, an empty database ---
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

    // Device B, which still has this item, has to lose it.
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

    // Device B changes the state and pushes.
    await updateItem(item.id, { favorite: true, tags: ['remote'] });
    await syncNow(provider);

    // Device A: an older version of the same item, with its own tag.
    await deleteDb();
    await saveItem({ url: URL_A, savedAt: 500, tags: ['local'] });

    const report = await syncNow(provider);

    const merged = await getItemByUrl(URL_A);
    expect(report.conflicts).toBe(1);
    expect(merged?.favorite).toBe(true);
    // The tags are the union of both sides, even though one side won the item.
    expect(merged?.tags).toEqual(['local', 'remote']);
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
    // What an older version, or a half-finished write, could leave behind. The
    // page prints these straight into a sentence.
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
