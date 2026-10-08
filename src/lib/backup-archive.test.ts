import { describe, expect, it } from 'vitest';

import { ImportError } from './backup';
import {
  ARCHIVE_BACKUP_ENTRY,
  ARCHIVE_BOOKMARKS_ENTRY,
  archiveFileName,
  buildBackupArchive,
  parseBackupArchive,
} from './backup-archive';
import { createZip, readZip } from './zip';
import type { SavedItem } from '@/types/item';

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

const ITEM: SavedItem = {
  id: 'one',
  url: 'https://a.example/article',
  resolvedUrl: 'https://a.example/article',
  title: 'Zażółć gęślą jaźń',
  excerpt: '',
  byline: null,
  siteName: null,
  lang: null,
  wordCount: 100,
  estReadingMinutes: 1,
  savedAt: NOW,
  updatedAt: NOW,
  readAt: null,
  archived: false,
  favorite: true,
  tags: ['rust'],
  contentHash: null,
  status: 'ready',
  readingProgress: 0,
  archivedKey: 0,
};

const DUMP = {
  items: [ITEM],
  contents: [{ itemId: 'one', html: '<p>Treść</p>', text: 'Treść', updatedAt: NOW }],
  highlights: [],
};

describe('the backup archive', () => {
  it('is named like the JSON backup', () => {
    expect(archiveFileName(NOW)).toMatch(/^savely-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('holds the full backup and the bookmarks', async () => {
    const files = await readZip(await buildBackupArchive(DUMP, 6, NOW));

    expect([...files.keys()]).toEqual([ARCHIVE_BACKUP_ENTRY, ARCHIVE_BOOKMARKS_ENTRY]);
    expect(new TextDecoder().decode(files.get(ARCHIVE_BOOKMARKS_ENTRY))).toContain(
      'https://a.example/article',
    );
  });

  it('round-trips items, content and tags', async () => {
    const plan = await parseBackupArchive(await buildBackupArchive(DUMP, 6, NOW), NOW);

    expect(plan.source).toBe('json');
    expect(plan.problems).toEqual([]);
    expect(plan.dump.items[0]).toMatchObject({ title: ITEM.title, tags: ['rust'], favorite: true });
    expect(plan.dump.contents[0]).toMatchObject({ html: '<p>Treść</p>' });
  });

  it('accepts a zip with a single JSON backup under another name', async () => {
    const original = await readZip(await buildBackupArchive(DUMP, 6, NOW));
    const backup = original.get(ARCHIVE_BACKUP_ENTRY) ?? new Uint8Array();
    const renamed = await createZip([{ name: 'my-copy.json', data: backup }]);

    expect((await parseBackupArchive(renamed, NOW)).dump.items).toHaveLength(1);
  });

  it('says plainly when the zip is not a Savely backup', async () => {
    const other = await createZip([{ name: 'notes.txt', data: new TextEncoder().encode('hi') }]);

    await expect(parseBackupArchive(other, NOW)).rejects.toBeInstanceOf(ImportError);
    await expect(parseBackupArchive(new Uint8Array([1, 2, 3]), NOW)).rejects.toThrow('not a ZIP');
  });
});
