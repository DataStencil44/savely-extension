/**
 * Formatting for the list cards. Pure functions - testable without a browser.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hostname without `www.`; an unparseable address is returned as-is. */
export function formatDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The save date in human terms. Freshness is counted in calendar days, not in
 * 24-hour spans - an article saved yesterday at 23:00 should read "yesterday",
 * not "today".
 */
export function formatSavedAt(savedAt: number, now = Date.now()): string {
  const start = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(savedAt)) / DAY_MS);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${String(days)} days ago`;
  if (days < 30) return `${String(Math.floor(days / 7))} wk ago`;

  return new Date(savedAt).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatReadingTime(minutes: number): string {
  if (minutes <= 0) return '';
  return `${String(minutes)} min`;
}

/** A short description of the item state when it is not "ready to read". */
export function formatStatus(status: 'pending' | 'ready' | 'failed'): string {
  switch (status) {
    case 'failed':
      return 'no content';
    case 'pending':
      return 'saving…';
    case 'ready':
      return '';
  }
}
