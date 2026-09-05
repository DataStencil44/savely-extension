/**
 * Tests for the data interchange formats. No database and no browser - the
 * `backup.ts` module is pure, and it is what decides what reaches the write at
 * all.
 *
 * The emphasis is on damaged files: an import should report, not explode and
 * not quietly let junk into the database.
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
    title: 'A title',
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

describe('file names', () => {
  it('carry the calendar day, not a timestamp', () => {
    const when = new Date(2026, 0, 5, 23, 30).getTime();
    expect(backupFileName(when)).toBe('savely-backup-2026-01-05.json');
    expect(bookmarksFileName(when)).toBe('savely-bookmarks-2026-01-05.html');
  });
});

describe('export and re-import', () => {
  it('round-trips without losses', () => {
    const dump = {
      items: [item({ url: 'https://a.example/1', tags: ['rust', 'web'], favorite: true })],
      contents: [
        { itemId: 'id-https://a.example/1', html: '<p>content</p>', text: 'content', updatedAt: NOW },
      ],
      highlights: [
        {
          id: 'h1',
          itemId: 'id-https://a.example/1',
          text: 'content',
          note: 'a note',
          createdAt: NOW,
          start: 0,
          end: 7,
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
    expect(plan.dump.highlights[0]?.note).toBe('a note');
  });
});

describe('Netscape bookmarks', () => {
  it('carry the format header, seconds in ADD_DATE and the tags', () => {
    const html = buildBookmarksHtml(
      [item({ url: 'https://a.example/1', title: 'A title', tags: ['rust'] })],
      NOW,
    );

    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('<DL><p>');
    expect(html).toContain(`ADD_DATE="${String(Math.floor(NOW / 1000))}"`);
    expect(html).toContain('TAGS="rust"');
    expect(html).toContain('>A title</A>');
  });

  it('escapes the address and the title', () => {
    const html = buildBookmarksHtml(
      [item({ url: 'https://a.example/?q=1&x=2', title: 'Cat <b>and</b> "dog"' })],
      NOW,
    );

    expect(html).toContain('HREF="https://a.example/?q=1&amp;x=2"');
    expect(html).toContain('Cat &lt;b&gt;and&lt;/b&gt; &quot;dog&quot;');
    expect(html).not.toContain('<b>and</b>');
  });

  it('falls back to the hostname when there is no title', () => {
    const html = buildBookmarksHtml([item({ url: 'https://a.example/1', title: '' })], NOW);
    expect(html).toContain('>a.example</A>');
  });
});

describe('JSON import: unacceptable files', () => {
  it('not JSON', () => {
    expect(() => parseBackup('this is not json', NOW)).toThrow(ImportError);
  });

  it('a foreign JSON without our format field', () => {
    expect(() => parseBackup('{"items":[]}', NOW)).toThrow(/Savely backup/);
  });

  it('a newer format version', () => {
    const file = JSON.stringify({
      format: 'savely-backup',
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      items: [],
    });
    expect(() => parseBackup(file, NOW)).toThrow(/newer format/);
  });

  it('an items field that is not a list', () => {
    const file = JSON.stringify({ format: 'savely-backup', formatVersion: 1, items: 'plenty' });
    expect(() => parseBackup(file, NOW)).toThrow(/is not a list/);
  });
});

describe('JSON import: individual damaged records', () => {
  const file = JSON.stringify({
    format: 'savely-backup',
    formatVersion: 1,
    items: [
      { url: 'https://a.example/1', title: 'A good one' },
      { title: 'No address' },
      'not an object at all',
      { url: 'https://a.example/1?utm_source=x', title: 'The same address after normalization' },
      { url: 'https://b.example/2', savedAt: 'yesterday', tags: ['x', 7], readingProgress: 42 },
    ],
    contents: [
      { itemId: 'no-such-item', html: '<p>an orphan</p>' },
      { itemId: 'another', text: 'without html' },
    ],
    highlights: [{ itemId: 'no-such-item', text: 'an orphan' }],
  });

  it('lets the healthy ones through and reports the rest with a place and a reason', () => {
    const plan = parseBackup(file, NOW);

    expect(plan.dump.items).toHaveLength(2);
    expect(plan.total).toBe(8);
    expect(plan.problems).toEqual([
      { where: 'item 2', reason: 'no address' },
      { where: 'item 3', reason: 'the item is not an object' },
      { where: 'item 4', reason: 'duplicate address in the file (already as item 1)' },
      { where: 'content 1', reason: 'content with no item in this file' },
      { where: 'content 2', reason: 'content with no item in this file' },
      { where: 'highlight 1', reason: 'a highlight with no item in this file' },
    ]);
  });

  it('repairs the fields that can be repaired', () => {
    const broken = parseBackup(file, NOW).dump.items[1];

    expect(broken?.savedAt).toBe(NOW);
    expect(broken?.tags).toEqual(['x']);
    // Progress out of range would break the reader's bar.
    expect(broken?.readingProgress).toBe(1);
    expect(broken?.status).toBe('pending');
  });
});

describe('parseCsv', () => {
  it('copes with quotes, commas and line breaks inside a field', () => {
    const rows = parseCsv('a,b\r\n"com,ma","a quote ""inside"""\n"two\nlines",x\n');

    expect(rows).toEqual([
      ['a', 'b'],
      ['com,ma', 'a quote "inside"'],
      ['two\nlines', 'x'],
    ]);
  });
});

describe('Pocket CSV import', () => {
  const csv = [
    'title,url,time_added,tags,status',
    '"Rust, that is",https://a.example/rust,1700000000,rust|web,unread',
    'Archived,https://b.example/x,1700000100,,archive',
    'No address,,1700000200,,unread',
    'Duplicate,https://a.example/rust?utm_source=nl,1700000300,,unread',
    '',
  ].join('\n');

  it('maps the columns by header and converts the time to milliseconds', () => {
    const plan = parsePocketCsv(csv, NOW);

    expect(plan.source).toBe('pocket-csv');
    expect(plan.dump.items).toHaveLength(2);
    expect(plan.dump.items[0]).toMatchObject({
      title: 'Rust, that is',
      url: 'https://a.example/rust',
      savedAt: 1_700_000_000_000,
      tags: ['rust', 'web'],
      archived: false,
      // Pocket returns no content - only saving the page will fetch it.
      status: 'pending',
    });
    expect(plan.dump.items[1]).toMatchObject({ archived: true, archivedKey: 1 });
  });

  it('reports rows without an address and duplicates, numbered like a spreadsheet', () => {
    expect(parsePocketCsv(csv, NOW).problems).toEqual([
      { where: 'row 4', reason: 'no address' },
      { where: 'row 5', reason: 'duplicate address in the file (already as row 2)' },
    ]);
  });

  it('refuses when there is no url column', () => {
    expect(() => parsePocketCsv('title,address\na,b', NOW)).toThrow(/no "url" column/);
    expect(() => parsePocketCsv('', NOW)).toThrow(ImportError);
  });
});

describe('parseImportFile', () => {
  it('picks the parser by extension, and without one by content', () => {
    const json = JSON.stringify({ format: 'savely-backup', formatVersion: 1, items: [] });
    const csv = 'title,url\nA,https://a.example/1';

    expect(parseImportFile('backup.json', json, NOW).source).toBe('json');
    expect(parseImportFile('pocket.csv', csv, NOW).source).toBe('pocket-csv');
    expect(parseImportFile('no-extension', json, NOW).source).toBe('json');
    expect(parseImportFile('no-extension', csv, NOW).source).toBe('pocket-csv');
  });
});

describe('summarizeProblems', () => {
  it('groups by reason, the most frequent on top, with examples', () => {
    const groups = summarizeProblems([
      { where: 'row 2', reason: 'no address' },
      { where: 'row 3', reason: 'a duplicate' },
      { where: 'row 4', reason: 'no address' },
      { where: 'row 5', reason: 'no address' },
      { where: 'row 6', reason: 'no address' },
    ]);

    expect(groups[0]).toEqual({
      reason: 'no address',
      count: 4,
      examples: ['row 2', 'row 4', 'row 5'],
    });
    expect(groups[1]?.count).toBe(1);
  });
});
