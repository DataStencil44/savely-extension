/**
 * Formatowanie do kart listy. Czyste funkcje - testowalne bez przegladarki.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Domena bez `www.`; adres nie do sparsowania oddajemy w calosci. */
export function formatDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Data zapisu po ludzku. Swiezosc liczymy w dniach kalendarzowych, nie
 * w dobach - artykul zapisany wczoraj o 23:00 ma byc "wczoraj", a nie "dzis".
 */
export function formatSavedAt(savedAt: number, now = Date.now()): string {
  const start = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(savedAt)) / DAY_MS);

  if (days <= 0) return 'dziś';
  if (days === 1) return 'wczoraj';
  if (days < 7) return `${String(days)} dni temu`;
  if (days < 30) return `${String(Math.floor(days / 7))} tyg. temu`;

  return new Date(savedAt).toLocaleDateString('pl-PL', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatReadingTime(minutes: number): string {
  if (minutes <= 0) return '';
  return `${String(minutes)} min`;
}

/** Krotki opis stanu pozycji, gdy jest inny niz "gotowa do czytania". */
export function formatStatus(status: 'pending' | 'ready' | 'failed'): string {
  switch (status) {
    case 'failed':
      return 'bez treści';
    case 'pending':
      return 'zapisywanie…';
    case 'ready':
      return '';
  }
}
