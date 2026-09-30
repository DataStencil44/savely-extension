import { describe, expect, it } from 'vitest';

import { parseQuery } from './query';

describe('parseQuery', () => {
  it('leaves an ordinary search alone', () => {
    expect(parseQuery('city centre cars')).toEqual({
      text: 'city centre cars',
      query: 'city centre cars',
      tags: [],
    });
  });

  it('a finished token becomes a tag and leaves the field', () => {
    expect(parseQuery('tag:rust ')).toEqual({ text: '', query: '', tags: ['rust'] });
  });

  it('waits for the space - a half-typed token is not a filter yet', () => {
    expect(parseQuery('tag:ru')).toEqual({ text: 'tag:ru', query: '', tags: [] });
  });

  it('Enter finishes the token being typed', () => {
    expect(parseQuery('tag:rust', true)).toEqual({ text: '', query: '', tags: ['rust'] });
  });

  it('keeps the words around the token, and searches only for them', () => {
    expect(parseQuery('centre tag:rust cars')).toEqual({
      text: 'centre cars',
      query: 'centre cars',
      tags: ['rust'],
    });
  });

  it('a half-typed token does not empty the list while it is being typed', () => {
    expect(parseQuery('centre tag:ru')).toEqual({
      text: 'centre tag:ru',
      query: 'centre',
      tags: [],
    });
  });

  it('takes several tokens at once', () => {
    expect(parseQuery('tag:rust tag:cities ')).toMatchObject({ tags: ['rust', 'cities'], text: '' });
  });

  it('quotes hold a tag with a space in it', () => {
    expect(parseQuery('tag:"city planning" ')).toEqual({
      text: '',
      query: '',
      tags: ['city planning'],
    });
    expect(parseQuery('tag:"city pla')).toMatchObject({ tags: [], query: '' });
  });

  it('accepts the tag written the way the chips show it', () => {
    expect(parseQuery('tag:#Rust ', false).tags).toEqual(['rust']);
  });

  it('says the same tag once', () => {
    expect(parseQuery('tag:rust tag:RUST ').tags).toEqual(['rust']);
  });

  it('`tag:` on its own filters nothing and is not searched for either', () => {
    expect(parseQuery('tag: ')).toEqual({ text: 'tag:', query: '', tags: [] });
    expect(parseQuery('tag:', true)).toEqual({ text: 'tag:', query: '', tags: [] });
  });

  it('a colon inside a word is not a token', () => {
    expect(parseQuery('https://example.com/tag:rust ')).toMatchObject({
      tags: [],
      query: 'https://example.com/tag:rust',
    });
  });
});
