/**
 * Testy formatów przenoszenia danych. Bez bazy i bez przeglądarki - moduł
 * `backup.ts` jest czysty, a to on decyduje, co w ogóle dojdzie do zapisu.
 *
 * Nacisk pada na pliki uszkodzone: import ma raportować, a nie wybuchać ani
 * po cichu wpuszczać śmieci do bazy.
 */
import { describe, expect, it } from 'vitest';

import {
  BACKUP_FORMAT_VERSION,
  ImportError,
  backupFileName,
  bookmarksFileName,
  buildBackup,
  buildBookmarksHtml,
  parseBackup,
  parseCsv,
  parseImportFile,
  parsePocketCsv,
  serializeBackup,
  summarizeProblems,
} from './backup';
import type { SavedItem } from './db';

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

function item(overrides: Partial<SavedItem> & Pick<SavedItem, 'url'>): SavedItem {
  return {
    id: `id-${overrides.url}`,
    resolvedUrl: overrides.url,
    title: 'Tytuł',
    excerpt: '',
    byline: null,
    siteName: null,
    lang: null,
    wordCount: 400,
    estReadingMinutes: 2,
    savedAt: NOW,
    updatedAt: NOW,
    readAt: null,
    archived: false,
    favorite: false,
    tags: [],
    contentHash: null,
    status: 'ready',
    readingProgress: 0,
    archivedKey: 0,
    ...overrides,
  };
}

describe('nazwy plików', () => {
  it('niosą datę dnia, nie znacznik czasu', () => {
    const when = new Date(2026, 0, 5, 23, 30).getTime();
    expect(backupFileName(when)).toBe('savely-backup-2026-01-05.json');
    expect(bookmarksFileName(when)).toBe('savely-bookmarks-2026-01-05.html');
  });
});

describe('eksport i ponowny import', () => {
  it('przechodzi w obie strony bez strat', () => {
    const dump = {
      items: [item({ url: 'https://a.example/1', tags: ['rust', 'web'], favorite: true })],
      contents: [
        { itemId: 'id-https://a.example/1', html: '<p>treść</p>', text: 'treść', updatedAt: NOW },
      ],
      highlights: [
        {
          id: 'h1',
          itemId: 'id-https://a.example/1',
          text: 'treść',
          note: 'notatka',
          createdAt: NOW,
          start: 0,
          end: 5,
          prefix: '',
          suffix: '',
        },
      ],
    };

    const file = buildBackup(dump, 3, NOW);
    expect(file.counts).toEqual({ items: 1, contents: 1, highlights: 1 });
    expect(file.schemaVersion).toBe(3);

    const plan = parseBackup(serializeBackup(file), NOW);
    expect(plan.problems).toEqual([]);
    expect(plan.dump.items[0]).toMatchObject({
      url: 'https://a.example/1',
      tags: ['rust', 'web'],
      favorite: true,
    });
    expect(plan.dump.contents).toHaveLength(1);
    expect(plan.dump.highlights[0]?.note).toBe('notatka');
  });
});

describe('zakładki Netscape', () => {
  it('mają nagłówek formatu, sekundy w ADD_DATE i tagi', () => {
    const html = buildBookmarksHtml(
      [item({ url: 'https://a.example/1', title: 'Tytuł', tags: ['rust'] })],
      NOW,
    );

    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('<DL><p>');
    expect(html).toContain(`ADD_DATE="${String(Math.floor(NOW / 1000))}"`);
    expect(html).toContain('TAGS="rust"');
    expect(html).toContain('>Tytuł</A>');
  });

  it('escape\'uje adres i tytuł', () => {
    const html = buildBookmarksHtml(
      [item({ url: 'https://a.example/?q=1&x=2', title: 'Kot <b>i</b> "pies"' })],
      NOW,
    );

    expect(html).toContain('HREF="https://a.example/?q=1&amp;x=2"');
    expect(html).toContain('Kot &lt;b&gt;i&lt;/b&gt; &quot;pies&quot;');
    expect(html).not.toContain('<b>i</b>');
  });

  it('bez tytułu bierze domenę', () => {
    const html = buildBookmarksHtml([item({ url: 'https://a.example/1', title: '' })], NOW);
    expect(html).toContain('>a.example</A>');
  });
});

describe('import JSON: pliki nie do przyjęcia', () => {
  it('nie-JSON', () => {
    expect(() => parseBackup('to nie jest json', NOW)).toThrow(ImportError);
  });

  it('obcy JSON bez naszego pola format', () => {
    expect(() => parseBackup('{"items":[]}', NOW)).toThrow(/kopia Savely/);
  });

  it('nowsza wersja formatu', () => {
    const file = JSON.stringify({
      format: 'savely-backup',
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      items: [],
    });
    expect(() => parseBackup(file, NOW)).toThrow(/nowszym formacie/);
  });

  it('pole items, które nie jest listą', () => {
    const file = JSON.stringify({ format: 'savely-backup', formatVersion: 1, items: 'sporo' });
    expect(() => parseBackup(file, NOW)).toThrow(/nie jest listą/);
  });
});

describe('import JSON: pojedyncze uszkodzone rekordy', () => {
  const file = JSON.stringify({
    format: 'savely-backup',
    formatVersion: 1,
    items: [
      { url: 'https://a.example/1', title: 'Dobra' },
      { title: 'Bez adresu' },
      'wcale nie obiekt',
      { url: 'https://a.example/1?utm_source=x', title: 'Ten sam adres po normalizacji' },
      { url: 'https://b.example/2', savedAt: 'wczoraj', tags: ['x', 7], readingProgress: 42 },
    ],
    contents: [
      { itemId: 'nie-ma-takiej', html: '<p>sierota</p>' },
      { itemId: 'inna', text: 'bez html-a' },
    ],
    highlights: [{ itemId: 'nie-ma-takiej', text: 'sierota' }],
  });

  it('przepuszcza zdrowe, resztę raportuje z miejscem i powodem', () => {
    const plan = parseBackup(file, NOW);

    expect(plan.dump.items).toHaveLength(2);
    expect(plan.total).toBe(8);
    expect(plan.problems).toEqual([
      { where: 'pozycja 2', reason: 'brak adresu' },
      { where: 'pozycja 3', reason: 'pozycja nie jest obiektem' },
      { where: 'pozycja 4', reason: 'duplikat adresu w pliku (już jako pozycja 1)' },
      { where: 'treść 1', reason: 'treść bez pozycji w tym pliku' },
      { where: 'treść 2', reason: 'treść bez pozycji w tym pliku' },
      { where: 'zaznaczenie 1', reason: 'zaznaczenie bez pozycji w tym pliku' },
    ]);
  });

  it('naprawia pola, które da się naprawić', () => {
    const broken = parseBackup(file, NOW).dump.items[1];

    expect(broken?.savedAt).toBe(NOW);
    expect(broken?.tags).toEqual(['x']);
    // Postęp poza zakresem zepsułby pasek w czytniku.
    expect(broken?.readingProgress).toBe(1);
    expect(broken?.status).toBe('pending');
  });
});

describe('parseCsv', () => {
  it('radzi sobie z cudzysłowami, przecinkami i łamaniem linii w polu', () => {
    const rows = parseCsv('a,b\r\n"prze,cinek","cudzysłów ""w środku"""\n"dwie\nlinie",x\n');

    expect(rows).toEqual([
      ['a', 'b'],
      ['prze,cinek', 'cudzysłów "w środku"'],
      ['dwie\nlinie', 'x'],
    ]);
  });
});

describe('import CSV z Pocketa', () => {
  const csv = [
    'title,url,time_added,tags,status',
    '"Rdza, czyli Rust",https://a.example/rust,1700000000,rust|web,unread',
    'Zarchiwizowany,https://b.example/x,1700000100,,archive',
    'Bez adresu,,1700000200,,unread',
    'Duplikat,https://a.example/rust?utm_source=nl,1700000300,,unread',
    '',
  ].join('\n');

  it('mapuje kolumny po nagłówku i przelicza czas na milisekundy', () => {
    const plan = parsePocketCsv(csv, NOW);

    expect(plan.source).toBe('pocket-csv');
    expect(plan.dump.items).toHaveLength(2);
    expect(plan.dump.items[0]).toMatchObject({
      title: 'Rdza, czyli Rust',
      url: 'https://a.example/rust',
      savedAt: 1_700_000_000_000,
      tags: ['rust', 'web'],
      archived: false,
      // Pocket nie oddaje treści - dociągnie ją dopiero zapis strony.
      status: 'pending',
    });
    expect(plan.dump.items[1]).toMatchObject({ archived: true, archivedKey: 1 });
  });

  it('raportuje wiersze bez adresu i duplikaty, numerując jak arkusz', () => {
    expect(parsePocketCsv(csv, NOW).problems).toEqual([
      { where: 'wiersz 4', reason: 'brak adresu' },
      { where: 'wiersz 5', reason: 'duplikat adresu w pliku (już jako wiersz 2)' },
    ]);
  });

  it('odmawia, gdy nie ma kolumny url', () => {
    expect(() => parsePocketCsv('tytul,adres\na,b', NOW)).toThrow(/kolumny "url"/);
    expect(() => parsePocketCsv('', NOW)).toThrow(ImportError);
  });
});

describe('parseImportFile', () => {
  it('wybiera parser po rozszerzeniu, a bez niego po zawartości', () => {
    const json = JSON.stringify({ format: 'savely-backup', formatVersion: 1, items: [] });
    const csv = 'title,url\nA,https://a.example/1';

    expect(parseImportFile('kopia.json', json, NOW).source).toBe('json');
    expect(parseImportFile('pocket.csv', csv, NOW).source).toBe('pocket-csv');
    expect(parseImportFile('bez-rozszerzenia', json, NOW).source).toBe('json');
    expect(parseImportFile('bez-rozszerzenia', csv, NOW).source).toBe('pocket-csv');
  });
});

describe('summarizeProblems', () => {
  it('grupuje po powodzie, najczęstsze na górze, z przykładami', () => {
    const groups = summarizeProblems([
      { where: 'wiersz 2', reason: 'brak adresu' },
      { where: 'wiersz 3', reason: 'duplikat' },
      { where: 'wiersz 4', reason: 'brak adresu' },
      { where: 'wiersz 5', reason: 'brak adresu' },
      { where: 'wiersz 6', reason: 'brak adresu' },
    ]);

    expect(groups[0]).toEqual({
      reason: 'brak adresu',
      count: 4,
      examples: ['wiersz 2', 'wiersz 4', 'wiersz 5'],
    });
    expect(groups[1]?.count).toBe(1);
  });
});
