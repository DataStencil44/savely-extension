import { describe, expect, it } from 'vitest';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from './format';
import { computeWindow, scrollTopFor } from './window';

const ROW = 104;

describe('computeWindow', () => {
  it('przy 5000 pozycjach renderuje kilkanascie wierszy, nie piec tysiecy', () => {
    const range = computeWindow({
      scrollTop: 0,
      viewportHeight: 600,
      total: 5_000,
      rowHeight: ROW,
      overscan: 4,
    });

    expect(range.totalHeight).toBe(5_000 * ROW);
    expect(range.start).toBe(0);
    // 600 / 104 -> 6 pelnych wierszy + 1 czesciowy + 4 zapasu
    expect(range.end - range.start).toBeLessThan(20);
  });

  it('okno przesuwa sie razem z przewijaniem i ma zapas z gory', () => {
    const range = computeWindow({
      scrollTop: 100 * ROW,
      viewportHeight: 600,
      total: 5_000,
      rowHeight: ROW,
      overscan: 4,
    });

    expect(range.start).toBe(96);
    expect(range.offsetY).toBe(96 * ROW);
    expect(range.end).toBeGreaterThan(100);
    expect(range.end - range.start).toBeLessThan(20);
  });

  it('nie wychodzi poza liste ani na poczatku, ani na koncu', () => {
    const top = computeWindow({
      scrollTop: -500,
      viewportHeight: 600,
      total: 10,
      rowHeight: ROW,
      overscan: 4,
    });
    expect(top.start).toBe(0);

    const bottom = computeWindow({
      scrollTop: 10_000,
      viewportHeight: 600,
      total: 10,
      rowHeight: ROW,
      overscan: 4,
    });
    expect(bottom.end).toBe(10);
    expect(bottom.start).toBeGreaterThanOrEqual(0);
  });

  it('pusta lista nie renderuje nic', () => {
    const range = computeWindow({
      scrollTop: 0,
      viewportHeight: 600,
      total: 0,
      rowHeight: ROW,
      overscan: 4,
    });
    expect(range).toEqual({ start: 0, end: 0, offsetY: 0, totalHeight: 0 });
  });
});

describe('scrollTopFor', () => {
  it('nie przewija, gdy wiersz jest w calosci widoczny', () => {
    expect(scrollTopFor(2, 0, 600, ROW)).toBeNull();
  });

  it('dociaga wiersz od gory i od dolu', () => {
    expect(scrollTopFor(0, 500, 600, ROW)).toBe(0);
    expect(scrollTopFor(10, 0, 600, ROW)).toBe(11 * ROW - 600);
  });
});

describe('formatowanie', () => {
  it('domena bez www', () => {
    expect(formatDomain('https://www.bbc.com/news/x')).toBe('bbc.com');
    expect(formatDomain('nie-adres')).toBe('nie-adres');
  });

  it('data po ludzku, liczona w dniach kalendarzowych', () => {
    const now = new Date('2026-09-02T10:00:00').getTime();
    expect(formatSavedAt(new Date('2026-09-02T01:00:00').getTime(), now)).toBe('dziś');
    // 23:00 poprzedniego dnia to "wczoraj", mimo ze minelo tylko 11 godzin
    expect(formatSavedAt(new Date('2026-09-01T23:00:00').getTime(), now)).toBe('wczoraj');
    expect(formatSavedAt(new Date('2026-08-30T12:00:00').getTime(), now)).toBe('3 dni temu');
    expect(formatSavedAt(new Date('2026-08-20T12:00:00').getTime(), now)).toBe('1 tyg. temu');
    expect(formatSavedAt(new Date('2026-01-05T12:00:00').getTime(), now)).toMatch(/2026/);
  });

  it('czas czytania i stan', () => {
    expect(formatReadingTime(4)).toBe('4 min');
    expect(formatReadingTime(0)).toBe('');
    expect(formatStatus('failed')).toBe('bez treści');
    expect(formatStatus('ready')).toBe('');
  });
});
