const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref']);
const TRACKING_PREFIX = 'utm_';

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

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized !== '') seen.add(normalized);
  }
  return [...seen].sort();
}
