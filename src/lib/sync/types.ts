export type SyncFiles = Record<string, string>;

export interface RemoteSnapshot {
  files: SyncFiles | null;
  revision: string | null;
}

export interface ConnectPrompt {
  kind: 'secret' | 'picker';
  label: string;
  help: string;
  placeholder?: string;
}

export class SyncConflictError extends Error {
  override readonly name = 'SyncConflictError';
}

export class SyncAccessError extends Error {
  override readonly name = 'SyncAccessError';
}

export interface SyncProvider {
  readonly id: string;
  readonly label: string;
  readonly dataLocation: string;
  readonly prompt: ConnectPrompt;

  authorize(secret?: string): Promise<void>;
  isConnected(): Promise<boolean>;
  describe(): Promise<string | null>;

  pull(): Promise<RemoteSnapshot>;
  push(files: SyncFiles, expectedRevision: string | null): Promise<string>;
  disconnect(): Promise<void>;
}

export const SYNC_FORMAT = 'savely-sync';
export const SYNC_FORMAT_VERSION = 1;

export const METADATA_FILE = 'savely-sync.json';
export const CONTENTS_FILE = 'savely-contents.json.gz.base64';

export interface SyncHighlight {
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

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
  contents: Record<string, SyncContent>;
}

export interface SyncReport {
  at: number;
  added: number;
  updated: number;
  deleted: number;
  contents: number;
  highlights: number;
  pushed: number;
  conflicts: number;
}
