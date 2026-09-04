// @vitest-environment jsdom
/**
 * Test strony opcji na jsdom: montujemy prawdziwy `options.html`, uruchamiamy
 * `options.ts` i klikamy jak użytkownik.
 *
 * Sprawdzamy to, czego nie widać w testach jednostkowych: że eksport pobiera
 * plik o właściwej nazwie, że import uszkodzonego pliku nie rusza bazy i mówi
 * dlaczego, a kasowanie danych wymaga potwierdzenia.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import html from './options.html?raw';

/** Pliki oddane do `downloads.download` - stąd wiemy, co poszło na dysk. */
const downloads = vi.hoisted(() => {
  const captured: { filename: string; url: string }[] = [];
  const noop = (): void => undefined;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: 'test',
        getURL: (path: string) => `chrome-extension://test/${path}`,
        lastError: null,
      },
      tabs: { create: noop },
      // Sekcja synchronizacji pyta providera o stan połączenia i o alarmy.
      storage: {
        local: {
          get: (_keys: unknown, callback: (items: Record<string, unknown>) => void) => {
            callback({});
          },
          set: (_items: unknown, callback: () => void) => {
            callback();
          },
          remove: (_key: unknown, callback: () => void) => {
            callback();
          },
        },
        onChanged: { addListener: noop },
      },
      permissions: {
        contains: (_options: unknown, callback: (result: boolean) => void) => {
          callback(false);
        },
      },
      alarms: {
        create: (_name: string, _options: unknown, callback?: () => void) => callback?.(),
        clear: (_name: string, callback?: (was: boolean) => void) => callback?.(true),
      },
      downloads: {
        download: (
          options: { url?: string; filename?: string },
          callback?: (id: number) => void,
        ) => {
          captured.push({ filename: options.filename ?? '', url: options.url ?? '' });
          callback?.(1);
        },
      },
    },
  });

  return captured;
});

const { buildBackup, serializeBackup } = await import('@/lib/backup');
const { DB_VERSION, deleteDb, listSnapshots, saveItem, setContent } = await import('@/lib/db');

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function click(selector: string): void {
  document.querySelector<HTMLElement>(selector)?.click();
}

function text(selector: string): string {
  return document.querySelector<HTMLElement>(selector)?.textContent ?? '';
}

/** Podaje plik tak, jak zrobiłby to `<input type="file">` po wyborze. */
async function importFile(name: string, content: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#import-file');
  if (input === null) throw new Error('brak pola pliku');

  // jsdom nie pozwala zbudować FileList - podstawiamy samą tablicę.
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([content], name, { type: 'text/plain' })],
  });
  input.dispatchEvent(new Event('change'));
  await settle(80);
}

beforeAll(async () => {
  await deleteDb();

  // jsdom nie implementuje ani <dialog>, ani obiektów Blob URL.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
  URL.createObjectURL = () => 'blob:savely/test';
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { estimate: () => Promise.resolve({ usage: 5 * 1024 * 1024, quota: 1024 * 1024 * 1024 }) },
  });

  const item = await saveItem({ url: 'https://a.example/1', title: 'Pierwszy', wordCount: 400 });
  await setContent(item.id, { html: '<p>a</p>', text: 'a' });
  await saveItem({ url: 'https://b.example/2', title: 'Drugi' });

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const script of parsed.querySelectorAll('script')) script.remove();
  document.body.replaceChildren(...parsed.body.childNodes);

  await import('./options');
  await settle(120);
});

describe('strona opcji', () => {
  it('pokazuje liczniki i zajęte miejsce', () => {
    const values = [...document.querySelectorAll('.stat__value')].map((node) => node.textContent);
    // pozycje, do przeczytania, archiwum, ulubione, z treścią, podświetlenia
    expect(values).toEqual(['2', '2', '0', '0', '1', '0']);
    expect(text('#storage')).toBe('Zajęte miejsce: 5,0 MB z 1,0 GB (0,5%).');
  });

  it('sekcja synchronizacji mówi wprost, gdzie trafią dane, zanim poprosi o token', () => {
    const location = text('#sync-location');
    expect(location).toContain('prywatnego Gista');
    expect(location).toContain('nie jest też zaszyfrowany');

    // Bez połączenia widać formularz, nie panel z „Synchronizuj teraz".
    expect(document.querySelector<HTMLElement>('#sync-connect')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#sync-connected')?.hidden).toBe(true);
    expect(text('#sync-secret-label')).toBe('Token osobisty GitHub');
  });

  it('eksportuje pełną kopię pod nazwą z datą', async () => {
    click('#export-json');
    await settle(60);

    const file = downloads.at(-1);
    expect(file?.filename).toMatch(/^savely-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(file?.url).toBe('blob:savely/test');
  });

  it('eksportuje zakładki jako osobny plik HTML', async () => {
    click('#export-html');
    await settle(60);

    expect(downloads.at(-1)?.filename).toMatch(/^savely-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('import kopii dokłada nowe pozycje i raportuje, co zrobił', async () => {
    const backup = serializeBackup(
      buildBackup(
        {
          items: [
            {
              id: 'z-pliku',
              url: 'https://c.example/3',
              resolvedUrl: 'https://c.example/3',
              title: 'Z kopii',
              excerpt: '',
              byline: null,
              siteName: null,
              lang: null,
              wordCount: 100,
              estReadingMinutes: 1,
              savedAt: 1_000,
              updatedAt: 1_000,
              readAt: null,
              archived: false,
              favorite: false,
              tags: [],
              contentHash: null,
              status: 'ready',
              readingProgress: 0,
              archivedKey: 0,
            },
          ],
          contents: [],
          highlights: [],
        },
        DB_VERSION,
        Date.now(),
      ),
    );

    await importFile('kopia.json', backup);

    const report = text('#report');
    expect(report).toContain('kopia Savely');
    expect(report).toContain('Dodano 1 nowych pozycji, scalono 0 istniejących.');
    expect(report).toContain('Nic nie zostało pominięte.');
    // Licznik pozycji odświeża się od razu.
    expect(document.querySelector('.stat__value')?.textContent).toBe('3');
  });

  it('import CSV z Pocketa raportuje pominięte wiersze z powodem', async () => {
    await importFile(
      'pocket.csv',
      ['title,url,time_added,tags,status', 'Bez adresu,,1700000000,,unread'].join('\n'),
    );

    expect(text('#report')).toContain('nie ma w nim ani jednej pozycji');
    expect(document.querySelector('#report')?.className).toContain('report--error');
  });

  it('uszkodzony plik nie rusza bazy', async () => {
    await importFile('smieci.json', '{to nie jest json');

    expect(text('#report')).toContain('Nie zaimportowano nic');
    expect(document.querySelector('.stat__value')?.textContent).toBe('3');
  });

  it('robi kopię na żądanie i pokazuje ją na liście', async () => {
    click('#snapshot-now');
    await settle(80);

    expect(await listSnapshots()).toHaveLength(1);
    expect(text('#snapshots')).toContain('3 pozycji');
  });

  it('kasowanie danych wymaga potwierdzenia', async () => {
    click('#wipe');
    await settle();

    const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog');
    expect(dialog?.open).toBe(true);
    expect(text('#confirm-text')).toContain('3 pozycji');

    click('#confirm-cancel');
    await settle();
    expect(document.querySelector('.stat__value')?.textContent).toBe('3');

    click('#wipe');
    await settle();
    click('#confirm-ok');
    await settle(80);

    expect(document.querySelector('.stat__value')?.textContent).toBe('0');
    expect(await listSnapshots()).toHaveLength(0);
  });
});
