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
  it('joins the text from the nodes and remembers where each one sits', () => {
    const root = render('<p>Amy has a <strong>cat</strong>.</p>');
    const map = buildTextMap(root);

    expect(map.text).toBe('Amy has a cat.');
    expect(map.segments).toHaveLength(3);
    expect(map.segments[1]).toMatchObject({ start: 10, end: 13 });
  });
});

describe('locate', () => {
  const text = 'The first paragraph. The second paragraph about bicycles. The third paragraph.';

  it('hits exactly when the text has not changed', () => {
    const anchor: Anchor = {
      start: 21,
      end: 35,
      quote: 'The second paragraph',
      prefix: 'The first paragraph. ',
      suffix: ' about bicycles',
    };
    expect(locate(text, { ...anchor, end: 41 })).toEqual({ start: 21, end: 41 });
  });

  it('finds the quote when the content shifted by a few dozen characters', () => {
    const anchor: Anchor = {
      start: 21,
      end: 41,
      quote: 'The second paragraph',
      prefix: 'The first paragraph. ',
      suffix: ' about bicycles',
    };
    // Somebody prepended an excerpt - the offsets no longer match.
    const prefix = 'An excerpt added later. ';
    const shifted = `${prefix}${text}`;

    expect(locate(shifted, anchor)).toEqual({
      start: 21 + prefix.length,
      end: 41 + prefix.length,
    });
  });

  it('with several occurrences it picks the one whose context matches', () => {
    const doubled = 'one cat two. three cat four.';
    const anchor: Anchor = {
      start: 0,
      end: 3,
      quote: 'cat',
      prefix: 'three ',
      suffix: ' four',
    };

    // The first "cat" is closer to offset 0, but the context points at the second.
    expect(locate(doubled, anchor)).toEqual({ start: 19, end: 22 });
  });

  it('without context, the distance from the original spot decides', () => {
    const doubled = 'one cat two. three cat four.';
    const anchor: Anchor = { start: 18, end: 21, quote: 'cat', prefix: '', suffix: '' };

    expect(locate(doubled, anchor)).toEqual({ start: 19, end: 22 });
  });

  it('returns null when the quote is gone', () => {
    const anchor: Anchor = { start: 0, end: 5, quote: 'nowhere to be found', prefix: '', suffix: '' };
    expect(locate(text, anchor)).toBeNull();
  });
});

describe('selecting in the DOM', () => {
  it('a user range turns into offsets and back into a marker', () => {
    const root = render('<p>Amy has a cat and a dog.</p>');
    const map = buildTextMap(root);

    const textNode = map.segments[0]?.node;
    if (textNode === undefined) throw new Error('no text node');

    const range = document.createRange();
    range.setStart(textNode, 10);
    range.setEnd(textNode, 13);

    const offsets = offsetsFromRange(map, range);
    expect(offsets).toEqual({ start: 10, end: 13 });
    if (offsets === null) return;

    const anchor = makeAnchor(map, offsets);
    expect(anchor.quote).toBe('cat');
    expect(anchor.prefix).toBe('Amy has a ');
    expect(anchor.suffix).toBe(' and a dog.');

    const marks = wrapRange(map, offsets, 'h1');
    expect(marks).toHaveLength(1);
    expect(root.querySelector('mark[data-highlight="h1"]')?.textContent).toBe('cat');
    // The article text has not changed - the offsets of other highlights still hold.
    expect(buildTextMap(root).text).toBe('Amy has a cat and a dog.');
  });

  it('a selection spanning several nodes gets a marker per piece', () => {
    const root = render('<p>Amy <strong>has</strong> a cat.</p>');
    const map = buildTextMap(root);

    const marks = wrapRange(map, { start: 2, end: 9 }, 'h2');

    expect(marks.length).toBeGreaterThan(1);
    expect(root.querySelectorAll('mark[data-highlight="h2"]')).toHaveLength(marks.length);
    expect(buildTextMap(root).text).toBe('Amy has a cat.');
  });

  it('removing a highlight restores the text without markers', () => {
    const root = render('<p>Amy has a cat.</p>');
    wrapRange(buildTextMap(root), { start: 10, end: 13 }, 'h3');
    expect(root.querySelectorAll('mark')).toHaveLength(1);

    unwrapHighlight(root, 'h3');

    expect(root.querySelectorAll('mark')).toHaveLength(0);
    expect(buildTextMap(root).text).toBe('Amy has a cat.');
  });
});
