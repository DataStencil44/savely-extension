/**
 * Test silnika na prawdziwej bazie (fake-indexeddb) i udawanym providerze,
 * który trzyma pliki w pamięci - dokładnie tak, jak trzymałby je Gist.
 *
 * Scenariusz jest ten, który interesuje użytkownika: „zapisałem na laptopie,
 * czy zobaczę to na telefonie". Drugie urządzenie udajemy czyszcząc bazę
 * i synchronizując ponownie - stan zdalny zostaje ten sam.
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
const { syncNow } = await import('./engine');
const { METADATA_FILE } = await import('./types');

/** Provider w pamięci: cała treść kontraktu i nic poza nim. */
class MemoryProvider implements SyncProvider {
  readonly id = 'memory';
  readonly label = 'Pamięć';
  readonly dataLocation = 'Nigdzie - to test.';
  readonly prompt = { kind: 'picker' as const, label: 'Miejsce', help: '' };

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
    return Promise.resolve('pamięć');
  }
  pull(): Promise<RemoteSnapshot> {
    return Promise.resolve({ files: this.files, revision: this.revision });
  }
  push(files: SyncFiles, expectedRevision: string | null): Promise<string> {
    if (expectedRevision !== this.revision) {
      throw new Error('wersja się rozjechała');
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

const URL_A = 'https://a.example/artykul';

beforeEach(async () => {
  await deleteDb();
});

afterEach(async () => {
  await deleteDb();
});

describe('pełne przejście', () => {
  it('wysyła stan lokalny, a drugie urządzenie dostaje go w całości', async () => {
    const provider = new MemoryProvider();

    // --- urządzenie A ---
    const item = await saveItem({ url: URL_A, title: 'Artykuł', tags: ['rust'] });
    await setContent(item.id, { html: '<p>treść</p>', text: 'treść' });
    await addHighlight({ itemId: item.id, text: 'cytat', start: 0, end: 5, note: 'ważne' });

    const first = await syncNow(provider);
    expect(first.pushed).toBe(1);
    expect(first.added).toBe(0);
    expect(provider.files?.[METADATA_FILE]).toContain('"title": "Artykuł"');

    // --- urządzenie B: ta sama skrzynka, pusta baza ---
    await deleteDb();
    const second = await syncNow(provider);

    expect(second.added).toBe(1);
    expect(second.contents).toBe(1);
    expect(second.highlights).toBe(1);

    const restored = await getItemByUrl(URL_A);
    expect(restored?.title).toBe('Artykuł');
    expect(restored?.tags).toEqual(['rust']);
    expect((await getContent(restored?.id ?? ''))?.html).toBe('<p>treść</p>');
    expect((await listHighlights(restored?.id ?? ''))[0]?.note).toBe('ważne');
  });

  it('drugie przejście bez zmian nie rusza bazy', async () => {
    const provider = new MemoryProvider();
    await saveItem({ url: URL_A });

    await syncNow(provider);
    const again = await syncNow(provider);

    expect(again).toMatchObject({ added: 0, updated: 0, deleted: 0, contents: 0, highlights: 0 });
  });

  it('kasowanie propaguje się zamiast wracać przy następnym scaleniu', async () => {
    const provider = new MemoryProvider();

    const item = await saveItem({ url: URL_A });
    await syncNow(provider);

    await deleteItem(item.id);
    await syncNow(provider);
    expect(provider.files?.[METADATA_FILE]).toContain('"tombstones"');

    // Urządzenie B, które wciąż ma tę pozycję, musi ją stracić.
    await deleteDb();
    await saveItem({ url: URL_A, savedAt: 1_000 });
    const report = await syncNow(provider);

    expect(report.deleted).toBe(1);
    expect(await getItemByUrl(URL_A)).toBeUndefined();
  });

  it('zmiana na drugim urządzeniu dociera i wygrywa po dacie', async () => {
    const provider = new MemoryProvider();

    const item = await saveItem({ url: URL_A, title: 'Tytuł' });
    await syncNow(provider);

    // Urządzenie B zmienia stan i wysyła.
    await updateItem(item.id, { favorite: true, tags: ['zdalny'] });
    await syncNow(provider);

    // Urządzenie A: starsza wersja tej samej pozycji, z własnym tagiem.
    await deleteDb();
    await saveItem({ url: URL_A, savedAt: 500, tags: ['lokalny'] });

    const report = await syncNow(provider);

    const merged = await getItemByUrl(URL_A);
    expect(report.conflicts).toBe(1);
    expect(merged?.favorite).toBe(true);
    // Tagi to suma z obu stron, mimo że pozycję wygrała jedna.
    expect(merged?.tags).toEqual(['lokalny', 'zdalny']);
  });
});
