/**
 * The sync payload: object <-> provider files.
 *
 * Two files, because they have different life cycles and different sizes:
 * metadata (JSON, small, human-readable) and content (gzip + base64, large, not
 * for reading). The split also lets a "local folder" provider version the
 * metadata in git without dragging in megabytes of HTML.
 *
 * Data coming back from a provider is external data (CLAUDE.md 3): it may have
 * been hand-edited in the gist, may come from an older version of the extension
 * or from an entirely different program. Every field is validated.
 */
import { normalizeTags, normalizeUrl } from '../url';

import { gunzipFromBase64, gzipToBase64 } from './compress';
import {
  CONTENTS_FILE,
  METADATA_FILE,
  SYNC_FORMAT,
  SYNC_FORMAT_VERSION,
  type SyncContent,
  type SyncFiles,
  type SyncHighlight,
  type SyncItem,
  type SyncPayload,
} from './types';

/** The file is unfit for merging - better to stop than to merge junk. */
export class SyncPayloadError extends Error {
  override readonly name = 'SyncPayloadError';
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

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const STATUSES: readonly string[] = ['pending', 'ready', 'failed'];

function readHighlight(raw: unknown): SyncHighlight | null {
  if (!isRecord(raw)) return null;
  const text = raw['text'];
  if (typeof text !== 'string' || text === '') return null;

  return {
    text,
    note: asNullableString(raw['note']),
    createdAt: asNumber(raw['createdAt'], 0),
    start: Math.max(0, asNumber(raw['start'], 0)),
    end: Math.max(0, asNumber(raw['end'], 0)),
    prefix: asString(raw['prefix'], ''),
    suffix: asString(raw['suffix'], ''),
  };
}

function readItem(raw: unknown): SyncItem | null {
  if (!isRecord(raw)) return null;

  const url = raw['url'];
  if (typeof url !== 'string' || url.trim() === '') return null;

  const wordCount = Math.max(0, asNumber(raw['wordCount'], 0));
  const savedAt = asNumber(raw['savedAt'], 0);
  const status = raw['status'];
  const highlights = Array.isArray(raw['highlights']) ? raw['highlights'] : [];

  return {
    url: normalizeUrl(url),
    resolvedUrl: asString(raw['resolvedUrl'], url),
    title: asString(raw['title'], ''),
    excerpt: asString(raw['excerpt'], ''),
    byline: asNullableString(raw['byline']),
    siteName: asNullableString(raw['siteName']),
    lang: asNullableString(raw['lang']),
    wordCount,
    estReadingMinutes: Math.max(0, asNumber(raw['estReadingMinutes'], 0)),
    savedAt,
    // Without `updatedAt` a conflict cannot be resolved - the safest move is
    // to pretend the record is as old as possible, so it does not overwrite a
    // fresher side.
    updatedAt: asNumber(raw['updatedAt'], savedAt),
    readAt: asNullableNumber(raw['readAt']),
    archived: raw['archived'] === true,
    favorite: raw['favorite'] === true,
    tags: normalizeTags(
      Array.isArray(raw['tags']) ? raw['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
    ),
    contentHash: asNullableString(raw['contentHash']),
    status: typeof status === 'string' && STATUSES.includes(status) ? (status as SyncItem['status']) : 'pending',
    readingProgress: Math.min(1, Math.max(0, asNumber(raw['readingProgress'], 0))),
    highlights: highlights
      .map(readHighlight)
      .filter((highlight): highlight is SyncHighlight => highlight !== null),
  };
}

function readContents(raw: unknown): Record<string, SyncContent> {
  if (!isRecord(raw)) return {};

  const contents: Record<string, SyncContent> = {};
  for (const [url, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const html = value['html'];
    if (typeof html !== 'string') continue;

    contents[normalizeUrl(url)] = {
      html,
      text: asString(value['text'], ''),
      updatedAt: asNumber(value['updatedAt'], 0),
    };
  }
  return contents;
}

/** Object -> files. Content goes separately, compressed. */
export async function buildFiles(payload: SyncPayload): Promise<SyncFiles> {
  const metadata = {
    format: payload.format,
    formatVersion: payload.formatVersion,
    schemaVersion: payload.schemaVersion,
    updatedAt: payload.updatedAt,
    items: payload.items,
    tombstones: payload.tombstones,
  };

  return {
    // Two spaces of indentation: someone will eventually open this file in the gist viewer.
    [METADATA_FILE]: `${JSON.stringify(metadata, null, 2)}\n`,
    [CONTENTS_FILE]: await gzipToBase64(JSON.stringify(payload.contents)),
  };
}

/** Files -> object. Throws `SyncPayloadError` when this is not our data. */
export async function parseFiles(files: SyncFiles): Promise<SyncPayload> {
  const metadataText = files[METADATA_FILE];
  if (metadataText === undefined) {
    throw new SyncPayloadError(`No ${METADATA_FILE} file - this is not Savely data.`);
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new SyncPayloadError('The metadata on the other side is not valid JSON.');
  }

  if (!isRecord(metadata) || metadata['format'] !== SYNC_FORMAT) {
    throw new SyncPayloadError('This is not Savely sync data.');
  }

  const formatVersion = asNumber(metadata['formatVersion'], 0);
  if (formatVersion > SYNC_FORMAT_VERSION) {
    throw new SyncPayloadError(
      `The data uses a newer format (${String(formatVersion)}) than this version of the extension understands - update Savely on this device.`,
    );
  }

  const rawItems = Array.isArray(metadata['items']) ? metadata['items'] : [];
  const items: SyncItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const item = readItem(raw);
    // A duplicate address in the file: the first one wins, same as on import.
    if (item !== null && !seen.has(item.url)) {
      seen.add(item.url);
      items.push(item);
    }
  }

  const rawTombstones = Array.isArray(metadata['tombstones']) ? metadata['tombstones'] : [];
  const tombstones = rawTombstones
    .map((raw) => {
      if (!isRecord(raw)) return null;
      const url = raw['url'];
      if (typeof url !== 'string' || url === '') return null;
      return { url: normalizeUrl(url), deletedAt: asNumber(raw['deletedAt'], 0) };
    })
    .filter((entry): entry is { url: string; deletedAt: number } => entry !== null);

  let contents: Record<string, SyncContent> = {};
  const contentsText = files[CONTENTS_FILE];
  if (contentsText !== undefined && contentsText.trim() !== '') {
    try {
      contents = readContents(JSON.parse(await gunzipFromBase64(contentsText)));
    } catch {
      // Metadata without content is still worth merging - the content can be
      // recovered by saving the page again. Better than rejecting the whole
      // bundle.
      contents = {};
    }
  }

  return {
    format: SYNC_FORMAT,
    formatVersion,
    schemaVersion: asNumber(metadata['schemaVersion'], 0),
    updatedAt: asNumber(metadata['updatedAt'], 0),
    items,
    tombstones,
    contents,
  };
}
