export type ItemStatus = 'pending' | 'ready' | 'failed';

export interface SavedItem {
  id: string;
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
  status: ItemStatus;
  readingProgress: number;
  archivedKey: 0 | 1;
}

export interface ItemContent {
  itemId: string;
  html: string;
  text: string;
  updatedAt: number;
}

export interface Highlight {
  id: string;
  itemId: string;
  text: string;
  note: string | null;
  createdAt: number;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

export interface Tombstone {
  url: string;
  deletedAt: number;
}
