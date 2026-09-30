import { describe, expect, it } from 'vitest';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from './format';

describe('formatting', () => {
  it('host without www', () => {
    expect(formatDomain('https://www.bbc.com/news/x')).toBe('bbc.com');
    expect(formatDomain('not-an-address')).toBe('not-an-address');
  });

  it('the date in human terms, counted in calendar days', () => {
    const now = new Date('2026-09-02T10:00:00').getTime();
    expect(formatSavedAt(new Date('2026-09-02T01:00:00').getTime(), now)).toBe('today');
    expect(formatSavedAt(new Date('2026-09-01T23:00:00').getTime(), now)).toBe('yesterday');
    expect(formatSavedAt(new Date('2026-08-30T12:00:00').getTime(), now)).toBe('3 days ago');
    expect(formatSavedAt(new Date('2026-08-20T12:00:00').getTime(), now)).toBe('1 wk ago');
    expect(formatSavedAt(new Date('2026-01-05T12:00:00').getTime(), now)).toMatch(/2026/);
  });

  it('reading time and status', () => {
    expect(formatReadingTime(4)).toBe('4 min');
    expect(formatReadingTime(0)).toBe('');
    expect(formatStatus('failed')).toBe('no content');
    expect(formatStatus('ready')).toBe('');
  });
});
