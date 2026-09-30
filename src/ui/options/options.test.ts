// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import html from './options.html?raw';

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

async function importFile(name: string, content: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#import-file');
  if (input === null) throw new Error('no file input');

  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([content], name, { type: 'text/plain' })],
  });
  input.dispatchEvent(new Event('change'));
  await settle(80);
}

beforeAll(async () => {
  await deleteDb();

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

  const item = await saveItem({ url: 'https://a.example/1', title: 'First', wordCount: 400 });
  await setContent(item.id, { html: '<p>a</p>', text: 'a' });
  await saveItem({ url: 'https://b.example/2', title: 'Second' });

  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const script of parsed.querySelectorAll('script')) script.remove();
  document.body.replaceChildren(...parsed.body.childNodes);

  await import('./options');
  await settle(120);
});

describe('the options page', () => {
  it('shows the counters and the storage usage', () => {
    const values = [...document.querySelectorAll('.stat__value')].map((node) => node.textContent);
    expect(values).toEqual(['2', '2', '0', '0', '1', '0']);
    expect(text('#storage')).toBe('Storage used: 5.0 MB of 1.0 GB (0.5%).');
  });

  it('the sync section says where the data goes before asking for a token', () => {
    const location = text('#sync-location');
    expect(location).toContain('private Gist');
    expect(location).toContain('not encrypted either');

    expect(document.querySelector<HTMLElement>('#sync-connect')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#sync-connected')?.hidden).toBe(true);
    expect(text('#sync-secret-label')).toBe('GitHub personal access token');
  });

  it('the theme buttons switch the whole UI and mark the current one', async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
    expect(buttons.map((button) => button.dataset['themeChoice'])).toEqual([
      'light',
      'dark',
      'sepia',
      'auto',
    ]);

    const pressed = (): string | undefined =>
      buttons.find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset[
        'themeChoice'
      ];
    expect(pressed()).toBe('light');

    buttons[1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(pressed()).toBe('dark');
  });

  it('exports a full backup under a dated name', async () => {
    click('#export-json');
    await settle(60);

    const file = downloads.at(-1);
    expect(file?.filename).toMatch(/^savely-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(file?.url).toBe('blob:savely/test');
  });

  it('exports the bookmarks as a separate HTML file', async () => {
    click('#export-html');
    await settle(60);

    expect(downloads.at(-1)?.filename).toMatch(/^savely-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('importing a backup adds new items and reports what it did', async () => {
    const backup = serializeBackup(
      buildBackup(
        {
          items: [
            {
              id: 'from-file',
              url: 'https://c.example/3',
              resolvedUrl: 'https://c.example/3',
              title: 'From the backup',
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

    await importFile('backup.json', backup);

    const report = text('#report');
    expect(report).toContain('a Savely backup');
    expect(report).toContain('Added 1 new items, merged 0 existing ones.');
    expect(report).toContain('Nothing was skipped.');
    expect(document.querySelector('.stat__value')?.textContent).toBe('3');
  });

  it('a Pocket CSV import reports the skipped rows with a reason', async () => {
    await importFile(
      'pocket.csv',
      ['title,url,time_added,tags,status', 'No address,,1700000000,,unread'].join('\n'),
    );

    expect(text('#report')).toContain('no item that could be saved');
    expect(document.querySelector('#report')?.className).toContain('report--error');
  });

  it('a damaged file leaves the database alone', async () => {
    await importFile('junk.json', '{this is not json');

    expect(text('#report')).toContain('Nothing was imported');
    expect(document.querySelector('.stat__value')?.textContent).toBe('3');
  });

  it('takes a backup on demand and shows it in the list', async () => {
    click('#snapshot-now');
    await settle(80);

    expect(await listSnapshots()).toHaveLength(1);
    expect(text('#snapshots')).toContain('3 items');
  });

  it('wiping the data requires confirmation', async () => {
    click('#wipe');
    await settle();

    const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog');
    expect(dialog?.open).toBe(true);
    expect(text('#confirm-text')).toContain('3 items');

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
