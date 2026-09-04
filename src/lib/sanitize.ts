/**
 * Sanityzacja tresci artykulu. To jest granica bezpieczenstwa: wszystko, co
 * wchodzi tutaj, pochodzi z cudzej strony i moze byc wrogie.
 *
 * Zasada: lista dozwolonych, nie lista zakazanych. Co nie jest wymienione -
 * wypada. `FORBID_*` nizej niczego nie dodaje merytorycznie, jest jawnym
 * zapisem intencji dla czytajacego (i dla audytu sklepu).
 */
import DOMPurify from 'dompurify';

/** Tekst, listy, obrazki, figure, cytaty, kod i tabele - nic wiecej. */
const ALLOWED_TAGS = [
  // tekst
  'p', 'br', 'hr', 'span', 'div', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup',
  'small', 'mark', 'abbr', 'cite', 'q', 'time', 'a',
  // listy
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // cytaty, kod
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  // media
  'figure', 'figcaption', 'img',
  // tabele
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
];

/** Bez `class`, `id` i `style` - czytnik ma wlasna typografie. */
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'lang', 'dir', 'datetime', 'cite',
  'width', 'height', 'colspan', 'rowspan', 'scope', 'rel', 'target',
];

/** Zapisane wprost, mimo ze i tak nie sa na liscie dozwolonych. */
const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'noscript'];
const FORBID_ATTR = ['style', 'class', 'id', 'srcset', 'sizes', 'loading'];

export interface SanitizedContent {
  html: string;
  text: string;
  wordCount: number;
}

/**
 * Zamienia adres wzgledny na bezwzgledny. `null` = adres nie do uratowania
 * albo o schemacie, ktorego nie chcemy w tresci.
 *
 * `data:` przechodzi wylacznie jako obrazek (`src`) i tylko z typem `image/*`.
 * W `href` nie ma po nim czego sie spodziewac poza `data:text/html`, a to jest
 * proba wykonania cudzego HTML-a w naszym origin - dlatego tam wypada zawsze.
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

/** Jedno slowo = ciag niebialych znakow. Dla CJK to przyblizenie i tyle. */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Wariant dla czytnika: gotowy fragment DOM do wstawienia przez `append()`.
 * Nigdy nie skladamy tresci przez `innerHTML` po stronie UI (CLAUDE.md 3).
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
    // Odczyt innerHTML (nie zapis) - tresc jest juz po DOMPurify.
    html: container.innerHTML,
    text,
    wordCount: countWords(text),
  };
}

/**
 * Wspolny rdzen: czysci HTML i oddaje go jako element-kontener.
 *
 * Przy okazji rozwiazuje `src`/`href` wzgledem `baseUrl` - inaczej zapisany
 * offline artykul mialby linki i obrazki wskazujace na `moz-extension://`
 * albo `chrome-extension://`.
 *
 * Hook jest zdejmowany w `finally`, bo DOMPurify trzyma go globalnie i przy
 * kolejnym wywolaniu rozwiazywalby adresy wzgledem poprzedniej strony.
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
        // Tresc jest cudza - link ma sie otwierac bez dostepu do naszej strony.
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
      // Atrybuty `on*` nie sa na liscie dozwolonych, wiec nie przechodza.
      RETURN_DOM_FRAGMENT: true,
    });

    const container = document.createElement('div');
    container.append(fragment);
    return container;
  } finally {
    DOMPurify.removeAllHooks();
  }
}
