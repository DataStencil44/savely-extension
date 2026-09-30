import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup',
  'small', 'mark', 'abbr', 'cite', 'q', 'time', 'a',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'figure', 'figcaption', 'img',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'lang', 'dir', 'datetime', 'cite',
  'width', 'height', 'colspan', 'rowspan', 'scope', 'rel', 'target',
];

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'noscript'];
const FORBID_ATTR = ['style', 'class', 'id', 'srcset', 'sizes', 'loading'];

export interface SanitizedContent {
  html: string;
  text: string;
  wordCount: number;
}

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

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

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
    html: container.innerHTML,
    text,
    wordCount: countWords(text),
  };
}

function sanitizeToContainer(html: string, baseUrl: string): HTMLDivElement {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    const href = node.getAttribute('href');
    if (href !== null) {
      const absolute = absolutize(href, baseUrl, false);
      if (absolute === null) node.removeAttribute('href');
      else {
        node.setAttribute('href', absolute);
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
      RETURN_DOM_FRAGMENT: true,
    });

    const container = document.createElement('div');
    container.append(fragment);
    return container;
  } finally {
    DOMPurify.removeAllHooks();
  }
}
