/**
 * Kotwiczenie podświetleń w tekście.
 *
 * Zapisujemy offsety w **czystym tekście** artykułu plus cytat i kilkadziesiąt
 * znaków kontekstu z obu stron. XPath albo ścieżka po węzłach padłaby przy
 * pierwszej zmianie znaczników (inny podział akapitów, doklejona zajawka,
 * zaktualizowana wersja artykułu). Tekst zmienia się rzadziej niż struktura,
 * a gdy offsety już nie pasują, `locate` odnajduje cytat po kontekście.
 *
 * `locate` jest czystą funkcją na stringach - stąd testy bez DOM-u.
 */

/** Ile znaków kontekstu zapisujemy z każdej strony zaznaczenia. */
export const CONTEXT_CHARS = 32;

export interface TextSegment {
  node: Text;
  /** Offset początku węzła w tekście całego artykułu. */
  start: number;
  end: number;
}

export interface TextMap {
  text: string;
  segments: TextSegment[];
}

export interface Anchor {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface TextRange {
  start: number;
  end: number;
}

/** Mapa: tekst artykułu w całości + gdzie w nim leży każdy węzeł tekstowy. */
export function buildTextMap(root: Node): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: TextSegment[] = [];
  let text = '';

  let node = walker.nextNode();
  while (node !== null) {
    const value = node.nodeValue ?? '';
    if (value !== '') {
      segments.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
    }
    node = walker.nextNode();
  }

  return { text, segments };
}

export function makeAnchor(map: TextMap, range: TextRange): Anchor {
  return {
    start: range.start,
    end: range.end,
    quote: map.text.slice(range.start, range.end),
    prefix: map.text.slice(Math.max(0, range.start - CONTEXT_CHARS), range.start),
    suffix: map.text.slice(range.end, range.end + CONTEXT_CHARS),
  };
}

/**
 * Znajduje zaznaczenie w tekście, który mógł się w międzyczasie przesunąć.
 *
 * Kolejność: dokładne trafienie offsetów -> najlepsze wystąpienie cytatu,
 * gdzie o wyborze decyduje zgodność kontekstu, a odległość od pierwotnego
 * offsetu tylko rozstrzyga remisy. `null`, gdy cytatu już nie ma.
 */
export function locate(text: string, anchor: Anchor): TextRange | null {
  if (anchor.quote === '') return null;

  if (text.slice(anchor.start, anchor.end) === anchor.quote) {
    return { start: anchor.start, end: anchor.end };
  }

  const candidates: number[] = [];
  let at = text.indexOf(anchor.quote);
  while (at !== -1 && candidates.length < 500) {
    candidates.push(at);
    at = text.indexOf(anchor.quote, at + 1);
  }
  if (candidates.length === 0) return null;

  let best = candidates[0] ?? 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    let score = 0;
    if (
      anchor.prefix !== '' &&
      text.slice(Math.max(0, candidate - anchor.prefix.length), candidate) === anchor.prefix
    ) {
      score += 4;
    }
    const after = candidate + anchor.quote.length;
    if (anchor.suffix !== '' && text.slice(after, after + anchor.suffix.length) === anchor.suffix) {
      score += 4;
    }
    // Im bliżej pierwotnego miejsca, tym lepiej - ale to tylko rozstrzygnięcie.
    score -= Math.abs(candidate - anchor.start) / Math.max(text.length, 1);

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { start: best, end: best + anchor.quote.length };
}

function offsetOfPoint(map: TextMap, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const segment = map.segments.find((entry) => entry.node === node);
    return segment === undefined ? null : segment.start + offset;
  }

  // Punkt w elemencie: `offset` to indeks dziecka. Bierzemy pierwszy węzeł
  // tekstowy od tego miejsca w prawo, a gdy go nie ma - koniec poprzedniego.
  const children = [...node.childNodes];
  const after = children.slice(offset);
  for (const child of after) {
    const segment = map.segments.find((entry) => child.contains(entry.node));
    if (segment !== undefined) return segment.start;
  }
  for (const child of children.slice(0, offset).reverse()) {
    const matching = map.segments.filter((entry) => child.contains(entry.node));
    const last = matching[matching.length - 1];
    if (last !== undefined) return last.end;
  }
  return null;
}

/** Zakres z zaznaczenia użytkownika sprowadzony do offsetów tekstowych. */
export function offsetsFromRange(map: TextMap, range: Range): TextRange | null {
  const start = offsetOfPoint(map, range.startContainer, range.startOffset);
  const end = offsetOfPoint(map, range.endContainer, range.endOffset);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

/**
 * Owija zakres w `<mark>`. Zaznaczenie potrafi przechodzić przez kilka węzłów
 * tekstowych (pogrubienia, linki), więc każdy kawałek dostaje własny znacznik.
 *
 * Węzły są dzielone, więc mapa po tej operacji jest nieaktualna - kolejne
 * podświetlenie liczymy z nowej mapy.
 */
export function wrapRange(map: TextMap, range: TextRange, highlightId: string): HTMLElement[] {
  const marks: HTMLElement[] = [];

  const touched = map.segments.filter(
    (segment) => segment.start < range.end && segment.end > range.start,
  );

  for (const segment of touched) {
    const localStart = Math.max(0, range.start - segment.start);
    const localEnd = Math.min(segment.node.length, range.end - segment.start);
    if (localEnd <= localStart) continue;

    let target = segment.node;
    if (localStart > 0) target = target.splitText(localStart);
    if (target.length > localEnd - localStart) target.splitText(localEnd - localStart);

    const mark = document.createElement('mark');
    mark.className = 'hl';
    mark.dataset['highlight'] = highlightId;
    target.replaceWith(mark);
    mark.append(target);
    marks.push(mark);
  }

  return marks;
}

/** Zdejmuje znaczniki jednego podświetlenia, scalając z powrotem tekst. */
export function unwrapHighlight(root: ParentNode, highlightId: string): void {
  for (const mark of root.querySelectorAll(`mark[data-highlight="${highlightId}"]`)) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    mark.replaceWith(...mark.childNodes);
    parent.normalize();
  }
}
