import { describe, expect, it } from 'vitest';

import { SearchIndex, tokenize } from './search';

function makeIndex(): SearchIndex {
  const index = new SearchIndex();
  index.addItem({ id: 'a', title: 'A new school year', excerpt: 'Changes in the canteens' });
  index.addItem({ id: 'b', title: 'Elections in Moldova', excerpt: 'The campaign in its final days' });
  index.addItem({ id: 'c', title: 'Cycling in the city', excerpt: 'New bike lanes' });
  return index;
}

describe('tokenize', () => {
  it('folds diacritics down to plain letters', () => {
    expect(tokenize('Żółć ŁĄKA gęś')).toEqual(['zolc', 'laka', 'ges']);
  });

  it('splits on words and drops single-character junk', () => {
    expect(tokenize('a b, cd-ef!')).toEqual(['cd', 'ef']);
  });
});

describe('SearchIndex', () => {
  it('finds by title and by excerpt', () => {
    const index = makeIndex();
    expect(index.search('school')).toEqual(['a']);
    expect(index.search('campaign')).toEqual(['b']);
  });

  it('ignores diacritics in the query and in the data', () => {
    const index = new SearchIndex();
    index.addItem({ id: 'a', title: 'Kraków', excerpt: 'Ścieżki rowerowe' });
    expect(index.search('krakow')).toEqual(['a']);
    expect(index.search('ścieżki')).toEqual(['a']);
  });

  it('matches prefixes (tokenize: forward)', () => {
    const index = makeIndex();
    expect(index.search('cycl')).toContain('c');
  });

  it('content arrives after the metadata and is searchable too', () => {
    const index = makeIndex();
    expect(index.search('inspectorate')).toEqual([]);

    index.setText('a', 'The inspectorate announced audits in primary schools.');
    expect(index.search('inspectorate')).toEqual(['a']);

    expect(index.search('school')).toEqual(['a']);
  });

  it('a hit in the title weighs more than one in the content', () => {
    const index = new SearchIndex();
    index.addItem({ id: 'title', title: 'City bicycle', excerpt: '' });
    index.addItem({ id: 'content', title: 'Something else entirely', excerpt: '' });
    index.setText('content', 'The word bicycle shows up in the text, but only midway through.');

    expect(index.search('bicycle')[0]).toBe('title');
  });

  it('removal takes an item out of the results', () => {
    const index = makeIndex();
    index.remove('a');
    expect(index.search('school')).toEqual([]);
    expect(index.size).toBe(2);
  });

  it('an empty query returns nothing', () => {
    expect(makeIndex().search('   ')).toEqual([]);
  });

  it('copes with five thousand items', () => {
    const index = new SearchIndex();
    for (let i = 0; i < 5_000; i += 1) {
      index.addItem({
        id: `id-${String(i)}`,
        title: `Article number ${String(i)} about bicycles`,
        excerpt: 'A test excerpt',
      });
    }
    index.setText('id-4999', 'The last text contains the word locomotive.');

    expect(index.size).toBe(5_000);
    expect(index.search('locomotive')).toEqual(['id-4999']);
    expect(index.search('bicycles', 10).length).toBe(10);
  });
});
