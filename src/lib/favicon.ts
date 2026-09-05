/**
 * The site icon shown on list cards.
 *
 * The icon is stored as **bytes**, not as an address: the list has to draw
 * something on a plane and the extension makes no network requests of its own
 * (CLAUDE.md 1). Fetching it is therefore part of saving the page - the one
 * moment we are already talking to that site - and everything afterwards reads
 * from IndexedDB.
 *
 * Icons live per domain, not per item: one copy of `example.com/favicon.ico`
 * serves every article saved from there.
 *
 * This module touches no browser API beyond `fetch`, so it runs in the content
 * script (path A) and in the service worker (path B) alike.
 */

import type { ExtractOutcome } from '@/types/article';

/** Bigger than this and it is not a favicon any more - we would rather show nothing. */
export const MAX_FAVICON_BYTES = 64 * 1024;

/** How long we wait for the icon. The save must not hang on a slow CDN. */
const FETCH_TIMEOUT_MS = 3000;

const ICON_SELECTORS: readonly string[] = [
  'link[rel~="icon" i]',
  'link[rel="shortcut icon" i]',
  'link[rel="apple-touch-icon" i]',
  'link[rel="apple-touch-icon-precomposed" i]',
];

/**
 * The key icons are stored under: the hostname without `www.`, lowercase.
 *
 * It has to agree with what the list shows as the item's domain
 * (`formatDomain`), because that is how the card looks the icon up.
 */
export function faviconKey(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * The icon declared by the document, or the address every browser tries anyway.
 *
 * `<link rel="icon">` wins over `/favicon.ico` because a site that declares an
 * icon usually declares a better one than the file in the root.
 */
export function findFaviconUrl(doc: Document, pageUrl: string): string | null {
  for (const selector of ICON_SELECTORS) {
    for (const link of doc.querySelectorAll(selector)) {
      const href = link.getAttribute('href')?.trim();
      if (href === undefined || href === '') continue;
      const resolved = resolveIconUrl(href, pageUrl);
      if (resolved !== null) return resolved;
    }
  }

  return resolveIconUrl('/favicon.ico', pageUrl);
}

/**
 * Only `http(s)` and `data:`. A `javascript:` or `blob:` href in `<link>` is
 * page data like any other and never becomes something we fetch (CLAUDE.md 3).
 */
function resolveIconUrl(href: string, pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  if (url.protocol === 'data:' && url.pathname.startsWith('image/')) return url.toString();
  return null;
}

/**
 * The image formats we recognize, by their first bytes.
 *
 * The type comes from the content, not from `Content-Type`: servers hand out
 * favicons as `text/plain` and `application/octet-stream` often enough that
 * trusting the header would drop perfectly good icons - and a header claiming
 * `image/png` over something else would produce a data URL that never renders.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  // RIFF....WEBP - the format tag sits after the four size bytes.
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte)) {
    return 'image/webp';
  }
  if (isSvg(bytes)) return 'image/svg+xml';

  return null;
}

/** An SVG is text, so it is recognized by its opening markup rather than a signature. */
function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).trimStart().toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype svg');
}

function toDataUrl(bytes: Uint8Array, type: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Fetches the icon and returns it as a `data:` URL, or `null` for every kind of
 * failure - a missing icon is a cosmetic loss and must never fail a save.
 *
 * `credentials: 'omit'`: an icon is not worth sending the user's cookies for.
 */
export async function fetchFaviconDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url.length > MAX_FAVICON_BYTES ? null : url;

  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }

  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return null;

  const type = sniffImageType(bytes);
  if (type === null) return null;

  return toDataUrl(bytes, type);
}

/** The icon address carried by an extraction result, whatever shape it came back in. */
export function faviconUrlOf(outcome: ExtractOutcome): string | null {
  switch (outcome.kind) {
    case 'article':
      return outcome.article.faviconUrl;
    case 'stub':
      return outcome.stub.faviconUrl;
    case 'refused':
      return null;
  }
}

/** The whole capture in one call: from the address in the document to the bytes. */
export async function captureFavicon(faviconUrl: string | null): Promise<string | null> {
  if (faviconUrl === null) return null;
  return fetchFaviconDataUrl(faviconUrl);
}
