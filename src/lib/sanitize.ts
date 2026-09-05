/**
 * Sanitizing article content. This is the security boundary: everything that
 * enters here comes from someone else's page and may be hostile.
 *
 * The rule: an allowlist, not a blocklist. Whatever is not listed is dropped.
 * The `FORBID_*` lists below add nothing substantive; they state the intent
 * explicitly for the reader (and for a store review).
 */
import DOMPurify from 'dompurify';

/** Text, lists, images, figures, quotes, code and tables - nothing more. */
const ALLOWED_TAGS = [
  // text
  'p', 'br', 'hr', 'span', 'div', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup',
  'small', 'mark', 'abbr', 'cite', 'q', 'time', 'a',
  // lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // quotes, code
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  // media
  'figure', 'figcaption', 'img',
  // tables
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
];

/** No `class`, `id` or `style` - the reader brings its own typography. */
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'lang', 'dir', 'datetime', 'cite',
  'width', 'height', 'colspan', 'rowspan', 'scope', 'rel', 'target',
];

/** Spelled out explicitly, even though they are not on the allowlist anyway. */
const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'noscript'];
const FORBID_ATTR = ['style', 'class', 'id', 'srcset', 'sizes', 'loading'];

export interface SanitizedContent {
  html: string;
  text: string;
  wordCount: number;
}

/**
 * Turns a relative address into an absolute one. `null` = an address beyond
 * saving, or one with a scheme we do not want in the content.
 *
 * `data:` passes only as an image (`src`) and only with an `image/*` type. In
 * an `href` there is nothing to expect from it but `data:text/html`, which is
 * an attempt to run someone else's HTML in our origin - so there it always
 * goes.
 */
function absolutize(value: string, base: string, allowImageData: boolean): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    if (allowImageData && url.protocol === 'data:' && url.pathname.startsWith('image/')) {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

/** One word = a run of non-whitespace characters. For CJK that is an approximation, no more. */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * The variant for the reader: a ready DOM fragment to insert with `append()`.
 * We never assemble content through `innerHTML` on the UI side (CLAUDE.md 3).
 */
export function sanitizeToFragment(html: string, baseUrl: string): DocumentFragment {
  const container = sanitizeToContainer(html, baseUrl);
  const fragment = document.createDocumentFragment();
  fragment.append(...container.childNodes);
  return fragment;
}

export function sanitizeArticleHtml(html: string, baseUrl: string): SanitizedContent {
  const container = sanitizeToContainer(html, baseUrl);
  const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim();

  return {
    // Reading innerHTML (not writing) - the content already went through DOMPurify.
    html: container.innerHTML,
    text,
    wordCount: countWords(text),
  };
}

/**
 * The shared core: cleans the HTML and returns it as a container element.
 *
 * Along the way it resolves `src`/`href` against `baseUrl` - otherwise an
 * article saved for offline reading would have links and images pointing at
 * `moz-extension://` or `chrome-extension://`.
 *
 * The hook is removed in `finally`, because DOMPurify keeps it globally and on
 * the next call would resolve addresses against the previous page.
 */
function sanitizeToContainer(html: string, baseUrl: string): HTMLDivElement {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    const href = node.getAttribute('href');
    if (href !== null) {
      const absolute = absolutize(href, baseUrl, false);
      if (absolute === null) node.removeAttribute('href');
      else {
        node.setAttribute('href', absolute);
        // The content is someone else's - a link must open without access to our page.
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }

    const src = node.getAttribute('src');
    if (src !== null) {
      const absolute = absolutize(src, baseUrl, true);
      if (absolute === null) node.remove();
      else node.setAttribute('src', absolute);
    }
  });

  try {
    const fragment = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      // `on*` attributes are not on the allowlist, so they never pass.
      RETURN_DOM_FRAGMENT: true,
    });

    const container = document.createElement('div');
    container.append(fragment);
    return container;
  } finally {
    DOMPurify.removeAllHooks();
  }
}
