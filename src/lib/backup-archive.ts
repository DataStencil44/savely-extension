import {
  ImportError,
  backupFileName,
  buildBackup,
  buildBookmarksHtml,
  parseBackup,
  serializeBackup,
  type ImportPlan,
} from './backup';
import { ZipError, createZip, readZip } from './zip';
import type { DatabaseDump } from './db';

export const ARCHIVE_BACKUP_ENTRY = 'savely-backup.json';
export const ARCHIVE_BOOKMARKS_ENTRY = 'bookmarks.html';

export function archiveFileName(when: number): string {
  return backupFileName(when).replace(/\.json$/, '.zip');
}

export async function buildBackupArchive(
  dump: DatabaseDump,
  schemaVersion: number,
  exportedAt: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return createZip(
    [
      {
        name: ARCHIVE_BACKUP_ENTRY,
        data: encoder.encode(serializeBackup(buildBackup(dump, schemaVersion, exportedAt))),
      },
      {
        name: ARCHIVE_BOOKMARKS_ENTRY,
        data: encoder.encode(buildBookmarksHtml(dump.items, exportedAt)),
      },
    ],
    new Date(exportedAt),
  );
}

function pickBackup(files: Map<string, Uint8Array>): Uint8Array {
  const named = files.get(ARCHIVE_BACKUP_ENTRY);
  if (named !== undefined) return named;

  const json = [...files].filter(([name]) => name.toLowerCase().endsWith('.json'));
  const only = json.length === 1 ? json[0] : undefined;
  if (only !== undefined) return only[1];

  throw new ImportError(`the archive has no ${ARCHIVE_BACKUP_ENTRY}.`);
}

export async function parseBackupArchive(bytes: Uint8Array, now = Date.now()): Promise<ImportPlan> {
  let files: Map<string, Uint8Array>;
  try {
    files = await readZip(bytes);
  } catch (error) {
    throw new ImportError(error instanceof ZipError ? error.message : 'the archive could not be read.');
  }
  return parseBackup(new TextDecoder().decode(pickBackup(files)), now);
}
