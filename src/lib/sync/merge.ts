import type { SyncBaseEntry, SyncLocalState, SyncWritePlan } from '../db';
import type { Highlight, SavedItem } from '@/types/item';
import { normalizeTags } from '../url';

import {
  SYNC_FORMAT,
  SYNC_FORMAT_VERSION,
  type SyncContent,
  type SyncHighlight,
  type SyncItem,
  type SyncPayload,
} from './types';

export interface MergeInput {
  local: SyncLocalState;
  remote: SyncPayload | null;
  schemaVersion: number;
  now: number;
}

export interface MergeResult {
  plan: SyncWritePlan;
  payload: SyncPayload;
  conflicts: number;
  base: SyncBaseEntry[];
}

function highlightKey(highlight: { text: string; start: number; end: number }): string {
  return `${highlight.text}\u0000${String(highlight.start)}\u0000${String(highlight.end)}`;
}

function toSyncHighlight(highlight: Highlight): SyncHighlight {
  return {
    text: highlight.text,
    note: highlight.note,
    createdAt: highlight.createdAt,
    start: highlight.start,
    end: highlight.end,
    prefix: highlight.prefix,
    suffix: highlight.suffix,
  };
}

function sortHighlights(highlights: readonly SyncHighlight[]): SyncHighlight[] {
  return [...highlights].sort((a, b) => highlightKey(a).localeCompare(highlightKey(b)));
}

type BaseHighlight = SyncBaseEntry['highlights'][number];

function pickNote(first: SyncHighlight, second: SyncHighlight): SyncHighlight {
  if (first.note === null && second.note !== null) return second;
  if (first.note !== null && second.note !== null && second.createdAt > first.createdAt) {
    return second;
  }
  return first;
}

function mergeNote(
  local: SyncHighlight,
  remote: SyncHighlight,
  base: BaseHighlight | undefined,
): SyncHighlight {
  if (local.note === remote.note) return local;
  if (base !== undefined) {
    if (local.note === base.note) return remote;
    if (remote.note === base.note) return local;
  }
  return pickNote(local, remote);
}

function mergeTags(
  local: readonly string[],
  remote: readonly string[],
  base: readonly string[] | undefined,
): string[] {
  if (base === undefined) return normalizeTags([...local, ...remote]);
  const inBase = new Set(base);
  const inLocal = new Set(local);
  const inRemote = new Set(remote);
  const kept = [...new Set([...local, ...remote])].filter(
    (tag) => (inLocal.has(tag) && inRemote.has(tag)) || !inBase.has(tag),
  );
  return normalizeTags(kept);
}

function mergeHighlights(
  local: readonly SyncHighlight[],
  remote: readonly SyncHighlight[],
  base: readonly BaseHighlight[] | undefined,
): SyncHighlight[] {
  const baseByKey = new Map((base ?? []).map((entry) => [highlightKey(entry), entry]));
  const localByKey = new Map(local.map((entry) => [highlightKey(entry), entry]));
  const remoteByKey = new Map(remote.map((entry) => [highlightKey(entry), entry]));

  const merged: SyncHighlight[] = [];
  for (const key of new Set([...localByKey.keys(), ...remoteByKey.keys()])) {
    const mine = localByKey.get(key);
    const theirs = remoteByKey.get(key);
    const was = baseByKey.get(key);

    if (mine !== undefined && theirs !== undefined) {
      merged.push(mergeNote(mine, theirs, was));
      continue;
    }

    const only = mine ?? theirs;
    if (only === undefined) continue;
    if (was?.note !== only.note) merged.push(only);
  }

  return sortHighlights(merged);
}

function toBaseEntry(item: SyncItem): SyncBaseEntry {
  return {
    url: item.url,
    tags: [...item.tags],
    highlights: item.highlights.map(({ text, note, start, end }) => ({ text, note, start, end })),
  };
}

function sameHighlights(a: readonly SyncHighlight[], b: readonly SyncHighlight[]): boolean {
  if (a.length !== b.length) return false;
  const left = sortHighlights(a);
  const right = sortHighlights(b);
  return left.every((highlight, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      highlightKey(highlight) === highlightKey(other) &&
      highlight.note === other.note
    );
  });
}

function toSyncItem(item: SavedItem, highlights: readonly SyncHighlight[]): SyncItem {
  return {
    url: item.url,
    resolvedUrl: item.resolvedUrl,
    title: item.title,
    excerpt: item.excerpt,
    byline: item.byline,
    siteName: item.siteName,
    lang: item.lang,
    wordCount: item.wordCount,
    estReadingMinutes: item.estReadingMinutes,
    savedAt: item.savedAt,
    updatedAt: item.updatedAt,
    readAt: item.readAt,
    archived: item.archived,
    favorite: item.favorite,
    tags: item.tags,
    contentHash: item.contentHash,
    status: item.status,
    readingProgress: item.readingProgress,
    highlights: sortHighlights(highlights),
  };
}

function sameItem(a: SyncItem, b: SyncItem): boolean {
  return (
    a.resolvedUrl === b.resolvedUrl &&
    a.title === b.title &&
    a.excerpt === b.excerpt &&
    a.byline === b.byline &&
    a.siteName === b.siteName &&
    a.lang === b.lang &&
    a.wordCount === b.wordCount &&
    a.estReadingMinutes === b.estReadingMinutes &&
    a.savedAt === b.savedAt &&
    a.updatedAt === b.updatedAt &&
    a.readAt === b.readAt &&
    a.archived === b.archived &&
    a.favorite === b.favorite &&
    a.contentHash === b.contentHash &&
    a.status === b.status &&
    a.readingProgress === b.readingProgress &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

interface LocalSide {
  items: Map<string, SyncItem>;
  contents: Map<string, SyncContent>;
}

function readLocal(local: SyncLocalState): LocalSide {
  const byId = new Map<string, SavedItem>();
  for (const item of local.items) byId.set(item.id, item);

  const highlights = new Map<string, SyncHighlight[]>();
  for (const highlight of local.highlights) {
    const item = byId.get(highlight.itemId);
    if (item === undefined) continue;
    const list = highlights.get(item.url) ?? [];
    list.push(toSyncHighlight(highlight));
    highlights.set(item.url, list);
  }

  const items = new Map<string, SyncItem>();
  for (const item of local.items) {
    items.set(item.url, toSyncItem(item, highlights.get(item.url) ?? []));
  }

  const contents = new Map<string, SyncContent>();
  for (const content of local.contents) {
    const item = byId.get(content.itemId);
    if (item === undefined) continue;
    contents.set(item.url, { html: content.html, text: content.text, updatedAt: content.updatedAt });
  }

  return { items, contents };
}

function toWritableItem(item: SyncItem): Omit<SavedItem, 'id' | 'archivedKey'> {
  return {
    url: item.url,
    resolvedUrl: item.resolvedUrl,
    title: item.title,
    excerpt: item.excerpt,
    byline: item.byline,
    siteName: item.siteName,
    lang: item.lang,
    wordCount: item.wordCount,
    estReadingMinutes: item.estReadingMinutes,
    savedAt: item.savedAt,
    updatedAt: item.updatedAt,
    readAt: item.readAt,
    archived: item.archived,
    favorite: item.favorite,
    tags: item.tags,
    contentHash: item.contentHash,
    status: item.status,
    readingProgress: item.readingProgress,
  };
}

export function mergeStates(input: MergeInput): MergeResult {
  const local = readLocal(input.local);

  const base = new Map<string, SyncBaseEntry>();
  if (input.remote !== null) {
    for (const entry of input.local.base) base.set(entry.url, entry);
  }

  const remoteItems = new Map<string, SyncItem>();
  for (const item of input.remote?.items ?? []) remoteItems.set(item.url, item);

  const remoteContents = new Map<string, SyncContent>();
  for (const [url, content] of Object.entries(input.remote?.contents ?? {})) {
    remoteContents.set(url, content);
  }

  const tombstones = new Map<string, number>();
  for (const tombstone of input.local.tombstones) {
    tombstones.set(tombstone.url, Math.max(tombstones.get(tombstone.url) ?? 0, tombstone.deletedAt));
  }
  for (const tombstone of input.remote?.tombstones ?? []) {
    tombstones.set(tombstone.url, Math.max(tombstones.get(tombstone.url) ?? 0, tombstone.deletedAt));
  }

  const plan: SyncWritePlan = { writes: [], deleteUrls: [], tombstones: [] };
  const payloadItems: SyncItem[] = [];
  const payloadContents: Record<string, SyncContent> = {};
  let conflicts = 0;

  const urls = new Set([...local.items.keys(), ...remoteItems.keys(), ...tombstones.keys()]);

  for (const url of urls) {
    const localItem = local.items.get(url);
    const remoteItem = remoteItems.get(url);
    const deletedAt = tombstones.get(url);

    let merged: SyncItem;
    if (localItem === undefined) {
      if (remoteItem === undefined) continue;
      merged = remoteItem;
    } else if (remoteItem === undefined) {
      merged = localItem;
    } else {
      if (!sameItem(localItem, remoteItem) || !sameHighlights(localItem.highlights, remoteItem.highlights)) {
        conflicts += 1;
      }
      const winner = remoteItem.updatedAt > localItem.updatedAt ? remoteItem : localItem;
      const was = base.get(url);
      merged = {
        ...winner,
        tags: mergeTags(localItem.tags, remoteItem.tags, was?.tags),
        highlights: mergeHighlights(localItem.highlights, remoteItem.highlights, was?.highlights),
      };
    }

    if (deletedAt !== undefined && deletedAt >= merged.updatedAt) {
      if (localItem !== undefined) plan.deleteUrls.push(url);
      continue;
    }

    const localContent = local.contents.get(url);
    const remoteContent = remoteContents.get(url);
    const mergedContent =
      localContent === undefined
        ? remoteContent
        : remoteContent === undefined
          ? localContent
          : remoteContent.updatedAt > localContent.updatedAt
            ? remoteContent
            : localContent;

    payloadItems.push(merged);
    if (mergedContent !== undefined) payloadContents[url] = mergedContent;

    const contentChanged =
      mergedContent !== undefined &&
      (localContent === undefined || mergedContent.updatedAt > localContent.updatedAt);
    const highlightsChanged =
      localItem === undefined || !sameHighlights(localItem.highlights, merged.highlights);
    const itemChanged = localItem === undefined || !sameItem(localItem, merged);

    if (itemChanged || contentChanged || highlightsChanged) {
      plan.writes.push({
        item: toWritableItem(merged),
        content: contentChanged && mergedContent !== undefined ? mergedContent : null,
        highlights: highlightsChanged ? merged.highlights : null,
      });
    }
  }

  plan.tombstones = [...tombstones].map(([url, deletedAt]) => ({ url, deletedAt }));

  return {
    plan,
    payload: {
      format: SYNC_FORMAT,
      formatVersion: SYNC_FORMAT_VERSION,
      schemaVersion: input.schemaVersion,
      updatedAt: input.now,
      items: payloadItems.sort((a, b) => a.url.localeCompare(b.url)),
      tombstones: plan.tombstones,
      contents: payloadContents,
    },
    conflicts,
    base: payloadItems.map(toBaseEntry),
  };
}
