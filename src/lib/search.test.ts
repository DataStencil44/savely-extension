import { describe, expect, it } from 'vitest';

import { SearchIndex, tokenize } from './search';

function makeIndex(): SearchIndex {
  const index = new SearchIndex();
  index.addItem({ id: 'a', title: 'Nowy rok szkolny', excerpt: 'Zmiany w stołówkach' });
  index.addItem({ id: 'b', title: 'Wybory w Mołdawii', excerpt: 'Kampania na finiszu' });
  index.addItem({ id: 'c', title: 'Rower w mieście', excerpt: 'Nowe ścieżki rowerowe' });
  return index;
}

describe('tokenize', () => {
  it('sprowadza polskie znaki do postaci bez ogonków', () => {
    expect(tokenize('Żółć ŁĄKA gęś')).toEqual(['zolc', 'laka', 'ges']);
  });

  it('tnie na słowach i odsiewa jednoznakowe śmieci', () => {
    expect(tokenize('a b, cd-ef!')).toEqual(['cd', 'ef']);
  });
});

describe('SearchIndex', () => {
  it('znajduje po tytule i po zajawce', () => {
    const index = makeIndex();
    expect(index.search('szkolny')).toEqual(['a']);
    expect(index.search('kampania')).toEqual(['b']);
  });

  it('ignoruje polskie diakrytyki w zapytaniu i w danych', () => {
    const index = makeIndex();
    expect(index.search('stolowkach')).toEqual(['a']);
    expect(index.search('ścieżki')).toEqual(['c']);
  });

  it('dopasowuje przedrostki (tokenize: forward)', () => {
    const index = makeIndex();
    expect(index.search('rowe')).toContain('c');
  });

  it('treść dochodzi po metadanych i też jest przeszukiwalna', () => {
    const index = makeIndex();
    expect(index.search('kuratorium')).toEqual([]);

    index.setText('a', 'Kuratorium zapowiedziało kontrole w szkołach podstawowych.');
    expect(index.search('kuratorium')).toEqual(['a']);

    // Metadane nie giną po dołożeniu treści.
    expect(index.search('szkolny')).toEqual(['a']);
  });

  it('trafienie w tytuł waży więcej niż w treści', () => {
    const index = new SearchIndex();
    index.addItem({ id: 'tytul', title: 'Rower miejski', excerpt: '' });
    index.addItem({ id: 'tresc', title: 'Zupełnie co innego', excerpt: '' });
    index.setText('tresc', 'W tekście pada słowo rower, ale dopiero w środku.');

    expect(index.search('rower')[0]).toBe('tytul');
  });

  it('usuniecie wyjmuje pozycję z wyników', () => {
    const index = makeIndex();
    index.remove('a');
    expect(index.search('szkolny')).toEqual([]);
    expect(index.size).toBe(2);
  });

  it('puste zapytanie nie zwraca nic', () => {
    expect(makeIndex().search('   ')).toEqual([]);
  });

  it('radzi sobie z pięcioma tysiącami pozycji', () => {
    const index = new SearchIndex();
    for (let i = 0; i < 5_000; i += 1) {
      index.addItem({
        id: `id-${String(i)}`,
        title: `Artykuł numer ${String(i)} o rowerach`,
        excerpt: 'Zajawka testowa',
      });
    }
    index.setText('id-4999', 'Ostatni tekst zawiera słowo lokomotywa.');

    expect(index.size).toBe(5_000);
    expect(index.search('lokomotywa')).toEqual(['id-4999']);
    expect(index.search('rowerach', 10).length).toBe(10);
  });
});
