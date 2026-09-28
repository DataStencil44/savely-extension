/**
 * Data interchange formats: what goes out to a file and what may come back in.
 *
 * With no backend a file is the only way out of this extension, so the format
 * has to be readable (JSON with an explicit schema version) and lossy only
 * where we deliberately want it to be (Netscape bookmarks are just the address,
 * title and tags).
 *
 * The whole module is pure: no IndexedDB, no `browser.*`, no DOM. The input is
 * a string from a file, the output is validated records or a report of
 * problems - writing to the database is left to `importDump` in
 * `src/lib/db/transfer.ts`, in a single transaction.
 *
 * An imported file is treated as external data (CLAUDE.md 3): it arrives as
 * `unknown`, every field is checked, and whatever we do not understand lands in
 * the report instead of the database.
 */
import { estimateReadingMinutes } from '@/types/article';

import { normalizeTags, normalizeUrl } from './url';
import {
  type DatabaseDump,
  type Highlight,
  type ItemContent,
  type ItemStatus,
  type SavedItem,
} from './db';

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT = 'savely-backup';

/**
 * The version of the **file format**, independent of the database schema
 * version. The schema can grow without changing the file layout; only a layout
 * change bumps this number.
 */
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupFile extends DatabaseDump {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** The IndexedDB schema version the dump was taken from - for diagnostics. */
  schemaVersion: number;
  exportedAt: number;
  counts: { items: number; contents: number; highlights: number };
}

export function buildBackup(
  dump: DatabaseDump,
  schemaVersion: number,
  exportedAt: number,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    exportedAt,
    counts: {
      items: dump.items.length,
      contents: dump.contents.length,
      highlights: dump.highlights.length,
    },
    ...dump,
  };
}

/**
 * No indentation: a backup with article content can run to tens of megabytes,
 * and pretty-printing adds a third on top. A program reads the file anyway.
 */
export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file);
}

function isoDay(when: number): string {
  const date = new Date(when);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function backupFileName(when: number): string {
  return `savely-backup-${isoDay(when)}.json`;
}

export function bookmarksFileName(when: number): string {
  return `savely-bookmarks-${isoDay(when)}.html`;
}

// ---------------------------------------------------------------------------
// Export to Netscape bookmarks
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackTitle(item: SavedItem): string {
  if (item.title !== '') return item.title;
  try {
    return new URL(item.resolvedUrl).hostname;
  } catch {
    return item.resolvedUrl;
  }
}

/**
 * The Netscape bookmarks format - the same one Chrome, Firefox and Safari read.
 * The requirements are prehistoric and literal: the doctype on the first line,
 * one `<DL><p>` and a `<DT><A HREF=...>` per entry. `ADD_DATE` is in seconds.
 *
 * We write the original address, not the normalized one - the browser should
 * open exactly what the user saved.
 */
export function buildBookmarksHtml(items: readonly SavedItem[], exportedAt: number): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Savely</H1>',
    '<DL><p>',
  ];

  for (const item of items) {
    const attributes = [
      `HREF="${escapeHtml(item.resolvedUrl)}"`,
      `ADD_DATE="${String(Math.floor(item.savedAt / 1000))}"`,
    ];
    if (item.tags.length > 0) attributes.push(`TAGS="${escapeHtml(item.tags.join(','))}"`);

    lines.push(`    <DT><A ${attributes.join(' ')}>${escapeHtml(fallbackTitle(item))}</A>`);
  }

  lines.push('</DL><p>', `<!-- savely, ${new Date(exportedAt).toISOString()} -->`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Import: shared types
// ---------------------------------------------------------------------------

/** The file is unusable - there is no point reporting it item by item. */
export class ImportError extends Error {
  override readonly name = 'ImportError';
}

export interface ImportProblem {
  /** Where in the file, in human terms: `item 12`, `row 34`. */
  where: string;
  reason: string;
}

export interface ImportPlan {
  source: 'json' | 'pocket-csv';
  /** Records ready for `importDump` - already validated and normalized. */
  dump: DatabaseDump;
  problems: ImportProblem[];
  /** How many records the file held in total (including the skipped ones). */
  total: number;
}

/** Reasons repeat hundreds of times - they go into the report grouped. */
export interface ProblemGroup {
  reason: string;
  count: number;
  /** The first few locations, so it can be found in the file. */
  examples: string[];
}

export function summarizeProblems(problems: readonly ImportProblem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();

  for (const problem of problems) {
    const group = groups.get(problem.reason) ?? { reason: problem.reason, count: 0, examples: [] };
    group.count += 1;
    if (group.examples.length < 3) group.examples.push(problem.where);
    groups.set(problem.reason, group);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeTags(value.filter((tag): tag is string => typeof tag === 'string'));
}

const STATUSES: readonly string[] = ['pending', 'ready', 'failed'];

function asStatus(value: unknown): ItemStatus {
  return typeof value === 'string' && STATUSES.includes(value) ? (value as ItemStatus) : 'pending';
}

/** Reading progress is a fraction - junk from a file must not break the reader's bar. */
function asProgress(value: unknown): number {
  const raw = asNumber(value, 0);
  return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Import: our own JSON
// ---------------------------------------------------------------------------

function readItem(raw: unknown, now: number): SavedItem | string {
  if (!isRecord(raw)) return 'the item is not an object';

  const rawUrl = raw['url'];
  const rawResolved = raw['resolvedUrl'];
  const source = typeof rawResolved === 'string' && rawResolved !== '' ? rawResolved : rawUrl;
  if (typeof source !== 'string' || source.trim() === '') return 'no address';

  const wordCount = Math.max(0, asNumber(raw['wordCount'], 0));
  const archived = asBoolean(raw['archived']);
  const savedAt = asNumber(raw['savedAt'], now);
  const readAt = raw['readAt'];

  return {
    id: asString(raw['id'], crypto.randomUUID()),
    url: normalizeUrl(source),
    resolvedUrl: source,
    title: asString(raw['title'], ''),
    excerpt: asString(raw['excerpt'], ''),
    byline: asNullableString(raw['byline']),
    siteName: asNullableString(raw['siteName']),
    lang: asNullableString(raw['lang']),
    wordCount,
    estReadingMinutes: Math.max(
      0,
      asNumber(raw['estReadingMinutes'], estimateReadingMinutes(wordCount)),
    ),
    savedAt: savedAt > 0 ? savedAt : now,
    // Older backups have no `updatedAt` - the save date is then the closest
    // approximation of the last change.
    updatedAt: asNumber(raw['updatedAt'], savedAt > 0 ? savedAt : now),
    readAt: typeof readAt === 'number' && Number.isFinite(readAt) ? readAt : null,
    archived,
    favorite: asBoolean(raw['favorite']),
    tags: asTags(raw['tags']),
    contentHash: asNullableString(raw['contentHash']),
    status: asStatus(raw['status']),
    readingProgress: asProgress(raw['readingProgress']),
    archivedKey: archived ? 1 : 0,
  };
}

function readContent(raw: unknown, known: ReadonlyMap<string, string>, now: number): ItemContent | string {
  if (!isRecord(raw)) return 'the content is not an object';

  const itemId = raw['itemId'];
  if (typeof itemId !== 'string' || !known.has(itemId)) return 'content with no item in this file';

  const html = raw['html'];
  if (typeof html !== 'string') return 'content without HTML';

  return {
    itemId,
    html,
    text: asString(raw['text'], ''),
    updatedAt: asNumber(raw['updatedAt'], now),
  };
}

function readHighlight(raw: unknown, known: ReadonlyMap<string, string>, now: number): Highlight | string {
  if (!isRecord(raw)) return 'the highlight is not an object';

  const itemId = raw['itemId'];
  if (typeof itemId !== 'string' || !known.has(itemId)) return 'a highlight with no item in this file';

  const text = raw['text'];
  if (typeof text !== 'string' || text === '') return 'a highlight without text';

  return {
    id: asString(raw['id'], crypto.randomUUID()),
    itemId,
    text,
    note: asNullableString(raw['note']),
    createdAt: asNumber(raw['createdAt'], now),
    start: Math.max(0, asNumber(raw['start'], 0)),
    end: Math.max(0, asNumber(raw['end'], 0)),
    prefix: asString(raw['prefix'], ''),
    suffix: asString(raw['suffix'], ''),
  };
}

function asArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImportError(`The "${field}" field is not a list.`);
  return value;
}

/**
 * Reads a Savely backup. It throws only when the file as a whole is
 * unacceptable (not JSON, not our format, a newer format version). A single
 * broken record goes to `problems` while the rest of the import proceeds
 * normally.
 */
export function parseBackup(text: string, now = Date.now()): ImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError('The file is not valid JSON.');
  }

  if (!isRecord(parsed)) throw new ImportError('The file contains no data object.');
  if (parsed['format'] !== BACKUP_FORMAT) {
    throw new ImportError('This is not a Savely backup (no "format": "savely-backup" field).');
  }

  const formatVersion = asNumber(parsed['formatVersion'], 0);
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    throw new ImportError(
      `The backup uses a newer format (${String(formatVersion)}) than this version of the extension understands.`,
    );
  }

  const rawItems = asArray(parsed['items'], 'items');
  const rawContents = asArray(parsed['contents'], 'contents');
  const rawHighlights = asArray(parsed['highlights'], 'highlights');

  const problems: ImportProblem[] = [];
  const items: SavedItem[] = [];
  /** id from the file -> normalized address; it doubles as the list of accepted items. */
  const accepted = new Map<string, string>();
  const seenUrls = new Map<string, number>();

  rawItems.forEach((raw, index) => {
    const where = `item ${String(index + 1)}`;
    const item = readItem(raw, now);
    if (typeof item === 'string') {
      problems.push({ where, reason: item });
      return;
    }

    // Two entries with the same address in one file: we take the first,
    // because the database would merge them into one record anyway - better to
    // say so plainly.
    const first = seenUrls.get(item.url);
    if (first !== undefined) {
      problems.push({
        where,
        reason: `duplicate address in the file (already as item ${String(first)})`,
      });
      return;
    }

    seenUrls.set(item.url, index + 1);
    accepted.set(item.id, item.url);
    items.push(item);
  });

  const contents: ItemContent[] = [];
  rawContents.forEach((raw, index) => {
    const content = readContent(raw, accepted, now);
    if (typeof content === 'string') {
      problems.push({ where: `content ${String(index + 1)}`, reason: content });
      return;
    }
    contents.push(content);
  });

  const highlights: Highlight[] = [];
  rawHighlights.forEach((raw, index) => {
    const highlight = readHighlight(raw, accepted, now);
    if (typeof highlight === 'string') {
      problems.push({ where: `highlight ${String(index + 1)}`, reason: highlight });
      return;
    }
    highlights.push(highlight);
  });

  return {
    source: 'json',
    dump: { items, contents, highlights },
    problems,
    total: rawItems.length + rawContents.length + rawHighlights.length,
  };
}

// ---------------------------------------------------------------------------
// Import: Pocket CSV
// ---------------------------------------------------------------------------

/**
 * CSV per RFC 4180: a comma separates, a double quote quotes, `""` inside is
 * one double quote. A hand-written parser, because article titles routinely
 * contain commas and quotes, and `split(',')` would lose whole rows on them.
 */
export function parseCsv(text: string): string[][] {
  // A BOM at the start of the file would end up in the first header column name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? '';

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else if (char === '\r' && input[i + 1] === '\n') {
        field += '\n';
        i += 1;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Pocket separates tags with a pipe; older exports sometimes use a comma. */
function pocketTags(value: string): string[] {
  return normalizeTags(value.split(/[|,]/));
}

/**
 * A Pocket export: `title,url,time_added,tags,status`. Columns are taken by
 * name from the header, not by position - the order changed between export
 * versions, but the header was there in every one.
 */
export function parsePocketCsv(text: string, now = Date.now()): ImportPlan {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) throw new ImportError('The CSV file is empty.');

  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    columns.set(name.trim().toLowerCase(), index);
  });

  const urlColumn = columns.get('url');
  if (urlColumn === undefined) {
    throw new ImportError('A CSV with no "url" column - this does not look like a Pocket export.');
  }

  const titleColumn = columns.get('title');
  const timeColumn = columns.get('time_added');
  const tagsColumn = columns.get('tags');
  const statusColumn = columns.get('status');

  const cell = (row: readonly string[], index: number | undefined): string =>
    index === undefined ? '' : (row[index] ?? '').trim();

  const problems: ImportProblem[] = [];
  const items: SavedItem[] = [];
  const seenUrls = new Map<string, number>();

  rows.slice(1).forEach((row, index) => {
    // Row numbers as in a spreadsheet: the header is 1, the first data row 2.
    const where = `row ${String(index + 2)}`;

    // A last line without a terminator yields an empty row - that is not an error.
    if (row.length === 1 && (row[0] ?? '') === '') return;

    const url = cell(row, urlColumn);
    if (url === '') {
      problems.push({ where, reason: 'no address' });
      return;
    }

    const normalized = normalizeUrl(url);
    const first = seenUrls.get(normalized);
    if (first !== undefined) {
      problems.push({
        where,
        reason: `duplicate address in the file (already as row ${String(first)})`,
      });
      return;
    }
    seenUrls.set(normalized, index + 2);

    const seconds = Number(cell(row, timeColumn));
    const savedAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now;
    const archived = cell(row, statusColumn).toLowerCase() === 'archive';

    items.push({
      id: crypto.randomUUID(),
      url: normalized,
      resolvedUrl: url,
      title: cell(row, titleColumn),
      excerpt: '',
      byline: null,
      siteName: null,
      lang: null,
      wordCount: 0,
      estReadingMinutes: 0,
      savedAt,
      updatedAt: savedAt,
      readAt: null,
      archived,
      favorite: false,
      tags: pocketTags(cell(row, tagsColumn)),
      contentHash: null,
      // Pocket gives addresses only - the content has to be fetched by saving the page.
      status: 'pending',
      readingProgress: 0,
      archivedKey: archived ? 1 : 0,
    });
  });

  return {
    source: 'pocket-csv',
    dump: { items, contents: [], highlights: [] },
    problems,
    total: Math.max(0, rows.length - 1),
  };
}

/**
 * Picks a parser by file extension, and when the name says nothing - by
 * content. A file with the wrong extension happens more often than a corrupt
 * one.
 */
export function parseImportFile(fileName: string, text: string, now = Date.now()): ImportPlan {
  const name = fileName.toLowerCase();
  if (name.endsWith('.csv')) return parsePocketCsv(text, now);
  if (name.endsWith('.json')) return parseBackup(text, now);
  return text.trimStart().startsWith('{') ? parseBackup(text, now) : parsePocketCsv(text, now);
}
