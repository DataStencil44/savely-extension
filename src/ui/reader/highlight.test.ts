// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  buildTextMap,
  locate,
  makeAnchor,
  offsetsFromRange,
  unwrapHighlight,
  wrapRange,
  type Anchor,
} from './highlight';

function render(html: string): HTMLElement {
  const root = document.createElement('div');
  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  root.append(...(parsed.body.firstElementChild?.childNodes ?? []));
  document.body.replaceChildren(root);
  return root;
}

describe('buildTextMap', () => {
  it('skleja tekst z węzłów i pamięta, gdzie który leży', () => {
    const root = render('<p>Ala ma <strong>kota</strong>.</p>');
    const map = buildTextMap(root);

    expect(map.text).toBe('Ala ma kota.');
    expect(map.segments).toHaveLength(3);
    expect(map.segments[1]).toMatchObject({ start: 7, end: 11 });
  });
});

describe('locate', () => {
  const text = 'Pierwszy akapit. Drugi akapit o rowerach. Trzeci akapit.';

  it('trafia dokładnie, gdy tekst się nie zmienił', () => {
    const anchor: Anchor = {
      start: 17,
      end: 30,
      quote: 'Drugi akapit',
      prefix: 'Pierwszy akapit. ',
      suffix: ' o rowerach',
    };
    expect(locate(text, { ...anchor, end: 29 })).toEqual({ start: 17, end: 29 });
  });

  it('odnajduje cytat, gdy treść przesunęła się o kilkadziesiąt znaków', () => {
    const anchor: Anchor = {
      start: 17,
      end: 29,
      quote: 'Drugi akapit',
      prefix: 'Pierwszy akapit. ',
      suffix: ' o rowerach',
    };
    // Ktoś dopisał zajawkę na początku - offsety już nie pasują.
    const shifted = `Zajawka dodana później. ${text}`;

    expect(locate(shifted, anchor)).toEqual({ start: 17 + 24, end: 29 + 24 });
  });

  it('przy kilku wystąpieniach wybiera to z pasującym kontekstem', () => {
    const doubled = 'raz kota dwa. trzy kota cztery.';
    const anchor: Anchor = {
      start: 0,
      end: 4,
      quote: 'kota',
      prefix: 'trzy ',
      suffix: ' cztery',
    };

    // Bliżej offsetu 0 jest pierwsze "kota", ale kontekst wskazuje drugie.
    expect(locate(doubled, anchor)).toEqual({ start: 19, end: 23 });
  });

  it('bez kontekstu rozstrzyga odległość od pierwotnego miejsca', () => {
    const doubled = 'raz kota dwa. trzy kota cztery.';
    const anchor: Anchor = { start: 18, end: 22, quote: 'kota', prefix: '', suffix: '' };

    expect(locate(doubled, anchor)).toEqual({ start: 19, end: 23 });
  });

  it('zwraca null, gdy cytatu już nie ma', () => {
    const anchor: Anchor = { start: 0, end: 5, quote: 'nie ma tego', prefix: '', suffix: '' };
    expect(locate(text, anchor)).toBeNull();
  });
});

describe('zaznaczanie w DOM', () => {
  it('zakres użytkownika zamienia się w offsety i z powrotem w znacznik', () => {
    const root = render('<p>Ala ma kota i psa.</p>');
    const map = buildTextMap(root);

    const textNode = map.segments[0]?.node;
    if (textNode === undefined) throw new Error('brak węzła tekstowego');

    const range = document.createRange();
    range.setStart(textNode, 7);
    range.setEnd(textNode, 11);

    const offsets = offsetsFromRange(map, range);
    expect(offsets).toEqual({ start: 7, end: 11 });
    if (offsets === null) return;

    const anchor = makeAnchor(map, offsets);
    expect(anchor.quote).toBe('kota');
    expect(anchor.prefix).toBe('Ala ma ');
    expect(anchor.suffix).toBe(' i psa.');

    const marks = wrapRange(map, offsets, 'h1');
    expect(marks).toHaveLength(1);
    expect(root.querySelector('mark[data-highlight="h1"]')?.textContent).toBe('kota');
    // Tekst artykułu się nie zmienił - offsety pozostałych podświetleń są dalej ważne.
    expect(buildTextMap(root).text).toBe('Ala ma kota i psa.');
  });

  it('zaznaczenie przez kilka węzłów dostaje znacznik na każdy kawałek', () => {
    const root = render('<p>Ala <strong>ma</strong> kota.</p>');
    const map = buildTextMap(root);

    const marks = wrapRange(map, { start: 2, end: 9 }, 'h2');

    expect(marks.length).toBeGreaterThan(1);
    expect(root.querySelectorAll('mark[data-highlight="h2"]')).toHaveLength(marks.length);
    expect(buildTextMap(root).text).toBe('Ala ma kota.');
  });

  it('zdjęcie podświetlenia przywraca tekst bez znaczników', () => {
    const root = render('<p>Ala ma kota.</p>');
    wrapRange(buildTextMap(root), { start: 7, end: 11 }, 'h3');
    expect(root.querySelectorAll('mark')).toHaveLength(1);

    unwrapHighlight(root, 'h3');

    expect(root.querySelectorAll('mark')).toHaveLength(0);
    expect(buildTextMap(root).text).toBe('Ala ma kota.');
  });
});
