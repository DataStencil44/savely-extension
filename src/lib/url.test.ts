import { describe, expect, it } from 'vitest';

import { normalizeTags, normalizeUrl } from './url';

describe('normalizeUrl', () => {
  it('strips tracking parameters', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(normalizeUrl('https://example.com/a?fbclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?gclid=abc')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a?ref=newsletter')).toBe('https://example.com/a');
  });

  it('keeps parameters that identify the content, and the fragment', () => {
    expect(normalizeUrl('https://example.com/?p=123&utm_campaign=q#chapter-2')).toBe(
      'https://example.com/?p=123#chapter-2',
    );
  });

  it('leaves no orphaned question mark', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x')).toBe('https://example.com/a');
  });

  it('an unparseable address comes back unchanged', () => {
    expect(normalizeUrl('  not-a-url  ')).toBe('not-a-url');
  });
});

describe('normalizeTags', () => {
  it('trims, lowercases, drops duplicates and sorts', () => {
    expect(normalizeTags([' Rust ', 'rust', 'TypeScript', '', '   '])).toEqual([
      'rust',
      'typescript',
    ]);
  });
});
