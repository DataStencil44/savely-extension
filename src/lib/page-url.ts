/**
 * Pure functions about addresses - no browser APIs, so testable without one.
 */

/**
 * Addresses not worth touching. PDFs are filtered out by extension right here,
 * so no script is injected into a PDF viewer; the second safeguard
 * (`document.contentType`) sits in `extractFromDocument`.
 *
 * Returns a message for the user, or `null` when the address is fine.
 */
export function checkPageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'I do not recognize this page address.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Savely only saves http(s) pages, and this is ${parsed.protocol}//`;
  }

  if (/\.pdf$/i.test(parsed.pathname)) {
    return 'This is a PDF, not an HTML page - Savely has nothing to build an article from.';
  }

  return null;
}

/** A match pattern for a whole host, e.g. `https://example.com/*`. */
export function hostPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}
