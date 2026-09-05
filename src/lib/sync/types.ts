/**
 * The sync contract: what a provider must do and what passes through it.
 *
 * A provider is **deliberately dumb** - it receives a few named text files and
 * an opaque revision marker, and returns the same. It knows nothing about
 * items, tags or merging; it never parses the contents. That makes adding a
 * second provider (a "local folder" on the File System Access API, Chrome-only,
 * say) a single new file plus an entry in the registry - the rest of the code
 * stays untouched.
 *
 * Serialization, compression and merging are handled by `payload.ts` and
 * `merge.ts`, and writing to the database by `applySync` in `src/lib/db.ts`.
 */

/** File name -> its text content. The provider never looks inside. */
export type SyncFiles = Record<string, string>;

export interface RemoteSnapshot {
  /** `null` when there is nothing on the other side yet. */
  files: SyncFiles | null;
  /**
   * The remote revision marker - a commit sha, an etag, a file mtime.
   * Opaque: the engine only hands it back on write, so the provider can detect
   * that someone changed the data in the meantime.
   */
  revision: string | null;
}

/** How the UI should ask for a connection. Every provider connects differently. */
export interface ConnectPrompt {
  /** `secret` = a text field (a token), `picker` = a single button (a folder). */
  kind: 'secret' | 'picker';
  label: string;
  /** What it is and where to get it - shown below the field. */
  help: string;
  placeholder?: string;
}

/** Raised when the remote revision changed between the read and the write. */
export class SyncConflictError extends Error {
  override readonly name = 'SyncConflictError';
}

/** Raised on a missing permission, a bad token and other access problems. */
export class SyncAccessError extends Error {
  override readonly name = 'SyncAccessError';
}

export interface SyncProvider {
  readonly id: string;
  readonly label: string;
  /**
   * One sentence about where the data physically lands and who will see it.
   * The UI shows this **before** connecting - the user should know what they
   * are agreeing to before pasting a token.
   */
  readonly dataLocation: string;
  readonly prompt: ConnectPrompt;

  /** Establishes the connection. `secret` for `kind: 'secret'`, omitted otherwise. */
  authorize(secret?: string): Promise<void>;
  isConnected(): Promise<boolean>;
  /** The concrete destination (a gist address, a folder name) or `null`. */
  describe(): Promise<string | null>;

  pull(): Promise<RemoteSnapshot>;
  /** Returns the new revision marker. Throws `SyncConflictError` on divergence. */
  push(files: SyncFiles, expectedRevision: string | null): Promise<string>;
  /** Erases the local credentials. It does NOT touch the data on the other side. */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

export const SYNC_FORMAT = 'savely-sync';
export const SYNC_FORMAT_VERSION = 1;

/** File names at the provider. Fixed - they are how we recognize our own data. */
export const METADATA_FILE = 'savely-sync.json';
export const CONTENTS_FILE = 'savely-contents.json.gz.base64';

/**
 * A highlight in the payload: without `id` and `itemId`, because identifiers
 * are local to a device. A highlight's identity is its quote plus its offsets.
 */
export interface SyncHighlight {
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

/**
 * An item in the payload. The key is the **normalized address**, not `id` - two
 * devices will never generate the same identifiers.
 */
export interface SyncItem {
  url: string;
  resolvedUrl: string;
  title: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  lang: string | null;
  wordCount: number;
  estReadingMinutes: number;
  savedAt: number;
  updatedAt: number;
  readAt: number | null;
  archived: boolean;
  favorite: boolean;
  tags: string[];
  contentHash: string | null;
  status: 'pending' | 'ready' | 'failed';
  readingProgress: number;
  highlights: SyncHighlight[];
}

export interface SyncContent {
  html: string;
  text: string;
  updatedAt: number;
}

export interface SyncPayload {
  format: typeof SYNC_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  updatedAt: number;
  items: SyncItem[];
  tombstones: { url: string; deletedAt: number }[];
  /** Address -> content. Stored in a separate, compressed file (gzip + base64). */
  contents: Record<string, SyncContent>;
}

// ---------------------------------------------------------------------------
// The sync result
// ---------------------------------------------------------------------------

export interface SyncReport {
  at: number;
  /** Items that arrived from the other side. */
  added: number;
  /** Items updated locally (the remote version was newer, or merged). */
  updated: number;
  /** Items deleted locally, because they disappeared on the other side. */
  deleted: number;
  contents: number;
  highlights: number;
  /** How many items went to the other side in this payload. */
  pushed: number;
  /** Conflicts resolved by `updatedAt` (both sides had changes). */
  conflicts: number;
}
