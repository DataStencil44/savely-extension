// @vitest-environment jsdom
/**
 * Testy ekstrakcji i sanityzacji na jsdom.
 *
 * Sanityzacje testujemy wprost na `sanitizeArticleHtml`, a nie przez wynik
 * Readability - inaczej test mowilby wiecej o heurystykach Readability niz
 * o naszej liscie dozwolonych tagow.
 */
import { describe, expect, it } from 'vitest';

import { extractFromDocument, extractFromHtml } from './extract';
import { sanitizeArticleHtml } from './sanitize';
import { checkPageUrl } from './page-url';

const BASE = 'https://gazeta.example/dzial/artykul-o-czyms';

/** Readability potrzebuje odpowiednio duzo tekstu, zeby uznac blok za tresc. */
const PARAGRAPH =
  'Rada miasta przyjela wczoraj uchwale o zmianie organizacji ruchu w scislym centrum. ' +
  'Zmiany obejma osiem ulic, a pierwsze znaki pojawia sie jeszcze w tym miesiacu. ' +
  'Urzednicy przekonuja, ze na przebudowie skorzystaja przede wszystkim piesi i rowerzysci, ' +
  'bo chodniki zostana poszerzone kosztem miejsc parkingowych wzdluz jezdni. ';

function articlePage(): string {
  return `<!doctype html>
<html lang="pl">
  <head>
    <title>Centrum bez samochodow - Gazeta</title>
    <meta property="og:title" content="Centrum bez samochodow" />
    <meta property="og:description" content="Osiem ulic zmieni organizacje ruchu." />
    <meta property="og:site_name" content="Gazeta Przykladowa" />
    <style>.reklama { display: block }</style>
  </head>
  <body>
    <nav><a href="/dzial">Miasto</a></nav>
    <article>
      <h1>Centrum bez samochodow</h1>
      <p class="autor">Anna Kowalska</p>
      <p>${PARAGRAPH}</p>
      <p>${PARAGRAPH}</p>
      <p>${PARAGRAPH}</p>
      <figure>
        <img src="/media/foto.jpg" alt="Ulica po przebudowie" />
        <figcaption>Ulica po przebudowie</figcaption>
      </figure>
      <p>${PARAGRAPH}</p>
      <p>Wiecej w <a href="../analiza">naszej analizie</a>.</p>
      <script>window.tracker = 1;</script>
      <iframe src="https://reklama.example/banner"></iframe>
    </article>
  </body>
</html>`;
}

describe('sanitizeArticleHtml', () => {
  it('wycina script, iframe, style i handlery on*', () => {
    const dirty = `
      <p onclick="steal()" onmouseover="x()">tekst</p>
      <script>alert(1)</script>
      <iframe src="https://zle.example"></iframe>
      <style>body { display: none }</style>
      <form><input name="haslo" /></form>
    `;
    const clean = sanitizeArticleHtml(dirty, BASE);

    expect(clean.html).toContain('<p>tekst</p>');
    expect(clean.html).not.toContain('onclick');
    expect(clean.html).not.toContain('onmouseover');
    expect(clean.html).not.toContain('<script');
    expect(clean.html).not.toContain('<iframe');
    expect(clean.html).not.toContain('<style');
    expect(clean.html).not.toContain('<input');
  });

  it('zostawia tagi tresciowe, wycina klasy i identyfikatory', () => {
    const dirty = `
      <h2 id="naglowek" class="duzy">Naglowek</h2>
      <ul><li>raz</li><li>dwa</li></ul>
      <blockquote>cytat</blockquote>
      <pre><code>const x = 1;</code></pre>
      <figure><img src="https://cdn.example/a.png" alt="a" /><figcaption>podpis</figcaption></figure>
      <table><thead><tr><th>rok</th></tr></thead><tbody><tr><td>2024</td></tr></tbody></table>
    `;
    const clean = sanitizeArticleHtml(dirty, BASE);

    for (const tag of ['h2', 'ul', 'li', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'img', 'table', 'th', 'td']) {
      expect(clean.html).toContain(`<${tag}`);
    }
    expect(clean.html).not.toContain('id="naglowek"');
    expect(clean.html).not.toContain('class="duzy"');
  });

  it('zamienia adresy wzgledne na bezwzgledne wzgledem strony', () => {
    const clean = sanitizeArticleHtml(
      '<p><a href="../inny">link</a></p><img src="/media/foto.jpg" alt="f" /><img src="//cdn.example/x.png" alt="x" />',
      BASE,
    );

    expect(clean.html).toContain('href="https://gazeta.example/inny"');
    expect(clean.html).toContain('src="https://gazeta.example/media/foto.jpg"');
    expect(clean.html).toContain('src="https://cdn.example/x.png"');
  });

  it('linki zewnetrzne dostaja rel="noopener noreferrer"', () => {
    const clean = sanitizeArticleHtml('<a href="https://inny.example/a">x</a>', BASE);
    expect(clean.html).toContain('rel="noopener noreferrer"');
    expect(clean.html).toContain('target="_blank"');
  });

  it('wycina adresy o niedozwolonych schematach', () => {
    const clean = sanitizeArticleHtml(
      '<a href="javascript:alert(1)">klik</a><img src="ftp://serwer/x.png" alt="x" />',
      BASE,
    );

    expect(clean.html).not.toContain('javascript:');
    expect(clean.html).not.toContain('ftp://');
    expect(clean.html).not.toContain('<img');
  });

  it('liczy slowa z czystego tekstu', () => {
    const clean = sanitizeArticleHtml('<p>raz dwa trzy</p><p>cztery</p>', BASE);
    expect(clean.text).toBe('raz dwa trzycztery');
    expect(clean.wordCount).toBe(3);
  });
});

describe('extractFromHtml', () => {
  it('wyciaga artykul, metadane i czas czytania', () => {
    const outcome = extractFromHtml(articlePage(), BASE);

    expect(outcome.kind).toBe('article');
    if (outcome.kind !== 'article') return;

    const { article } = outcome;
    expect(article.title).toContain('Centrum bez samochodow');
    expect(article.siteName).toBe('Gazeta Przykladowa');
    expect(article.lang).toBe('pl');
    expect(article.resolvedUrl).toBe(BASE);

    // tresc przeszla przez sanityzacje
    expect(article.html).not.toContain('<script');
    expect(article.html).not.toContain('<iframe');
    expect(article.html).toContain('src="https://gazeta.example/media/foto.jpg"');
    expect(article.html).toContain('href="https://gazeta.example/analiza"');

    // wordCount i czas czytania licza sie z tekstu, nie z HTML-a
    expect(article.wordCount).toBeGreaterThan(100);
    expect(article.estReadingMinutes).toBe(Math.max(1, Math.round(article.wordCount / 200)));
    expect(article.text).not.toContain('<');
  });

  it('gdy nie ma artykulu, zwraca wpis z og:description', () => {
    const outcome = extractFromHtml(
      `<!doctype html><html lang="en"><head>
         <title>Panel</title>
         <meta property="og:title" content="Panel klienta" />
         <meta property="og:description" content="Zaloguj sie, zeby zobaczyc dane." />
       </head><body><nav><a href="/a">a</a></nav><div id="app"></div></body></html>`,
      'https://panel.example/',
    );

    expect(outcome.kind).toBe('stub');
    if (outcome.kind !== 'stub') return;

    expect(outcome.problem).toBe('no-article');
    expect(outcome.stub.title).toBe('Panel klienta');
    expect(outcome.stub.excerpt).toBe('Zaloguj sie, zeby zobaczyc dane.');
    expect(outcome.stub.lang).toBe('en');
    expect(outcome.stub.resolvedUrl).toBe('https://panel.example/');
  });

  it('odmawia dla pustego dokumentu', () => {
    const outcome = extractFromHtml('<!doctype html><html><body></body></html>', BASE);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.problem).toBe('empty-document');
  });
});

describe('extractFromDocument', () => {
  it('odmawia dla dokumentu, ktory nie jest HTML-em (PDF)', () => {
    const doc = new DOMParser().parseFromString('<html><body>x</body></html>', 'text/html');
    // jsdom nie potrafi zrobic dokumentu PDF - podmieniamy sam typ, bo tylko
    // on decyduje o odmowie.
    Object.defineProperty(doc, 'contentType', { value: 'application/pdf' });

    const outcome = extractFromDocument(doc, 'https://example.com/raport.pdf');

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.problem).toBe('unsupported-document');
    expect(outcome.message).toContain('PDF');
  });

  it('nie rusza dokumentu, na ktorym pracuje', () => {
    const doc = new DOMParser().parseFromString(articlePage(), 'text/html');
    const before = doc.body.innerHTML;

    extractFromDocument(doc, BASE);

    // Readability przestawia i usuwa wezly - musi dostac klon, nie zywa strone.
    expect(doc.body.innerHTML).toBe(before);
  });
});

describe('checkPageUrl', () => {
  it('przepuszcza http(s)', () => {
    expect(checkPageUrl('https://example.com/a')).toBeNull();
    expect(checkPageUrl('http://example.com/a')).toBeNull();
  });

  it('odmawia dla PDF-a i schematow spoza http(s)', () => {
    expect(checkPageUrl('https://example.com/raport.pdf')).toContain('PDF');
    expect(checkPageUrl('https://example.com/RAPORT.PDF')).toContain('PDF');
    expect(checkPageUrl('file:///C:/plik.html')).toContain('http(s)');
    expect(checkPageUrl('about:blank')).toContain('http(s)');
    expect(checkPageUrl('chrome://extensions')).toContain('http(s)');
    expect(checkPageUrl('nie-adres')).toContain('Nie rozpoznaje');
  });
});
