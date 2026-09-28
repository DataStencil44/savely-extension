/**
 * The two canonical forms every layer compares by: an address without its
 * tracking parameters (the identity of an item on every device) and a tag set.
 *
 * Pure and dependency-free on purpose. Backups, the sync payload and the tag
 * editor all need them, and none of them should have to import the database to
 * get two string functions.
 */

/** Purely tracking parameters - they do not change the content, so they break deduplication. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref']);
const TRACKING_PREFIX = 'utm_';

/**
 * Reduces an address to a comparable form: strips `utm_*`, `fbclid`, `gclid`
 * and `ref`. The rest (path, remaining parameters, fragment) is left alone -
 * on many sites the fragment or `?p=123` is the article's only identifier.
 *
 * An unparseable address comes back trimmed but untouched: better to save
 * something odd than to fail the save.
 */
export function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  const params = parsed.searchParams;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(lower)) {
      params.delete(key);
    }
  }

  const query = params.toString();
  parsed.search = query === '' ? '' : `?${query}`;
  return parsed.toString();
}

/** Tags are kept in one canonical form so the multiEntry index stays predictable. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen].sort();
}
