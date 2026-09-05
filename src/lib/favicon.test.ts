// @vitest-environment jsdom
/**
 * Site icon tests.
 *
 * The pure parts (which address, which bytes) are tested directly; `fetch` is
 * stubbed, because the point of the module is that everything it accepts turns
 * into a `data:` URL and everything else turns into `null` - never a throw that
 * could take a save down with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureFavicon,
  faviconKey,
  faviconUrlOf,
  fetchFaviconDataUrl,
  findFaviconUrl,
  sniffImageType,
  MAX_FAVICON_BYTES,
} from './favicon';
import type { ExtractOutcome } from '@/types/article';

const PAGE = 'https://www.example.com/section/an-article';

function documentWith(head: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, 'text/html');
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function respondWith(bytes: Uint8Array, init: { ok?: boolean } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: init.ok ?? true,
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
      } as unknown as Response),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('faviconKey', () => {
  it('is the hostname without www, so one row serves the whole site', () => {
    expect(faviconKey('https://www.example.com/a')).toBe('example.com');
    expect(faviconKey('https://example.com/b?x=1')).toBe('example.com');
    expect(faviconKey('HTTPS://Example.COM/c')).toBe('example.com');
  });

  it('is null for an address that is not one', () => {
    expect(faviconKey('not an address')).toBeNull();
  });
});

describe('findFaviconUrl', () => {
  it('prefers the declared icon and resolves it against the page', () => {
    const doc = documentWith('<link rel="icon" href="/assets/icon-32.png">');
    expect(findFaviconUrl(doc, PAGE)).toBe('https://www.example.com/assets/icon-32.png');
  });

  it('takes an icon from another host too - the fetch decides whether it can be had', () => {
    const doc = documentWith('<link rel="icon" href="https://cdn.example.net/i.png">');
    expect(findFaviconUrl(doc, PAGE)).toBe('https://cdn.example.net/i.png');
  });

  it('falls back to /favicon.ico when the document declares nothing', () => {
    expect(findFaviconUrl(documentWith(''), PAGE)).toBe('https://www.example.com/favicon.ico');
  });

  it('falls back when the only declared icon is not fetchable', () => {
    const doc = documentWith('<link rel="icon" href="javascript:alert(1)">');
    expect(findFaviconUrl(doc, PAGE)).toBe('https://www.example.com/favicon.ico');
  });

  it('accepts an inline data: icon', () => {
    const doc = documentWith('<link rel="icon" href="data:image/png;base64,AAAA">');
    expect(findFaviconUrl(doc, PAGE)).toBe('data:image/png;base64,AAAA');
  });

  it('reads the apple variant when there is no plain icon', () => {
    const doc = documentWith('<link rel="apple-touch-icon" href="/touch.png">');
    expect(findFaviconUrl(doc, PAGE)).toBe('https://www.example.com/touch.png');
  });
});

describe('sniffImageType', () => {
  it('recognizes the formats a favicon comes in', () => {
    expect(sniffImageType(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe('image/x-icon');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="..."></svg>'))).toBe('image/svg+xml');
  });

  it('refuses anything else - an HTML error page is not an icon', () => {
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><html>404'))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe('fetchFaviconDataUrl', () => {
  it('returns the bytes as a data URL, typed by what they are', async () => {
    respondWith(PNG);
    await expect(fetchFaviconDataUrl('https://example.com/favicon.ico')).resolves.toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it('passes an inline icon through without a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchFaviconDataUrl('data:image/png;base64,AAAA')).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives up on a response that is not an image', async () => {
    respondWith(new TextEncoder().encode('<!doctype html><html>404</html>'));
    await expect(fetchFaviconDataUrl('https://example.com/favicon.ico')).resolves.toBeNull();
  });

  it('gives up on an error response', async () => {
    respondWith(PNG, { ok: false });
    await expect(fetchFaviconDataUrl('https://example.com/favicon.ico')).resolves.toBeNull();
  });

  it('gives up on something too big to be an icon', async () => {
    const huge = new Uint8Array(MAX_FAVICON_BYTES + 1);
    huge.set(PNG);
    respondWith(huge);
    await expect(fetchFaviconDataUrl('https://example.com/favicon.ico')).resolves.toBeNull();
  });

  it('swallows a network failure - a save must not die over a picture', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await expect(fetchFaviconDataUrl('https://example.com/favicon.ico')).resolves.toBeNull();
  });
});

describe('captureFavicon', () => {
  it('does nothing when there is no address', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(captureFavicon(null)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('faviconUrlOf', () => {
  const url = 'https://example.com/favicon.ico';

  it('reads the address out of every shape of outcome', () => {
    const article = {
      kind: 'article',
      article: { faviconUrl: url },
    } as unknown as ExtractOutcome;
    const stub = { kind: 'stub', problem: 'no-article', stub: { faviconUrl: url } } as unknown as ExtractOutcome;
    const refused = {
      kind: 'refused',
      problem: 'empty-document',
      message: '',
    } as unknown as ExtractOutcome;

    expect(faviconUrlOf(article)).toBe(url);
    expect(faviconUrlOf(stub)).toBe(url);
    expect(faviconUrlOf(refused)).toBeNull();
  });
});
