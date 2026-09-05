import { describe, expect, it } from 'vitest';

import { formatDomain, formatReadingTime, formatSavedAt, formatStatus } from './format';
import { computeWindow, scrollTopFor } from './window';

const ROW = 104;

describe('computeWindow', () => {
  it('renders a dozen rows for 5000 items, not five thousand', () => {
    const range = computeWindow({
      scrollTop: 0,
      viewportHeight: 600,
      total: 5_000,
      rowHeight: ROW,
      overscan: 4,
    });

    expect(range.totalHeight).toBe(5_000 * ROW);
    expect(range.start).toBe(0);
    // 600 / 104 -> 6 full rows + 1 partial + 4 of overscan
    expect(range.end - range.start).toBeLessThan(20);
  });

  it('the window moves with the scroll and keeps overscan above', () => {
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

  it('never runs past the list, at either end', () => {
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

  it('an empty list renders nothing', () => {
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
  it('does not scroll when the row is fully visible', () => {
    expect(scrollTopFor(2, 0, 600, ROW)).toBeNull();
  });

  it('pulls the row into view from the top and from the bottom', () => {
    expect(scrollTopFor(0, 500, 600, ROW)).toBe(0);
    expect(scrollTopFor(10, 0, 600, ROW)).toBe(11 * ROW - 600);
  });
});

describe('formatting', () => {
  it('host without www', () => {
    expect(formatDomain('https://www.bbc.com/news/x')).toBe('bbc.com');
    expect(formatDomain('not-an-address')).toBe('not-an-address');
  });

  it('the date in human terms, counted in calendar days', () => {
    const now = new Date('2026-09-02T10:00:00').getTime();
    expect(formatSavedAt(new Date('2026-09-02T01:00:00').getTime(), now)).toBe('today');
    // 23:00 the previous day is "yesterday", even though only 11 hours passed
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
