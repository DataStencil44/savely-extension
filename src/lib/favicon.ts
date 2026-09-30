import type { ExtractOutcome } from '@/types/article';

export const MAX_FAVICON_BYTES = 64 * 1024;

const FETCH_TIMEOUT_MS = 3000;

const TOTAL_BUDGET_MS = 6000;

const MAX_CANDIDATES = 4;

const ICON_SELECTORS: readonly string[] = [
  'link[rel~="icon" i]',
  'link[rel="shortcut icon" i]',
  'link[rel="apple-touch-icon" i]',
  'link[rel="apple-touch-icon-precomposed" i]',
];

export function faviconKey(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

export function findFaviconUrls(doc: Document, pageUrl: string): string[] {
  const candidates: string[] = [];

  const add = (url: string | null): void => {
    if (url !== null && !candidates.includes(url)) candidates.push(url);
  };

  for (const selector of ICON_SELECTORS) {
    for (const link of doc.querySelectorAll(selector)) {
      const href = link.getAttribute('href')?.trim();
      if (href === undefined || href === '') continue;
      add(resolveIconUrl(href, pageUrl));
    }
  }

  add(resolveIconUrl('/favicon.ico', pageUrl));

  return candidates.slice(0, MAX_CANDIDATES);
}

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

export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte)) {
    return 'image/webp';
  }
  if (isSvg(bytes)) return 'image/svg+xml';

  return null;
}

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

export async function fetchFaviconDataUrl(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  if (url.startsWith('data:')) return url.length > MAX_FAVICON_BYTES ? null : url;

  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
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

export function faviconUrlsOf(outcome: ExtractOutcome): string[] {
  switch (outcome.kind) {
    case 'article':
      return outcome.article.faviconUrls;
    case 'stub':
      return outcome.stub.faviconUrls;
    case 'refused':
      return [];
  }
}

export async function captureFavicon(faviconUrls: readonly string[]): Promise<string | null> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const url of faviconUrls.slice(0, MAX_CANDIDATES)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    const dataUrl = await fetchFaviconDataUrl(url, Math.min(FETCH_TIMEOUT_MS, remaining));
    if (dataUrl !== null) return dataUrl;
  }

  return null;
}
