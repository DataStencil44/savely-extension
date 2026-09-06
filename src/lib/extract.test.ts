// @vitest-environment jsdom
/**
 * Extraction and sanitization tests on jsdom.
 *
 * Sanitization is tested directly against `sanitizeArticleHtml` rather than
 * through Readability's output - otherwise the test would say more about
 * Readability's heuristics than about our allowlist of tags.
 */
import { describe, expect, it } from 'vitest';

import { extractFromDocument, extractFromHtml } from './extract';
import { sanitizeArticleHtml } from './sanitize';
import { checkPageUrl } from './page-url';

const BASE = 'https://daily.example/section/an-article-about-something';

/** Readability needs enough text before it accepts a block as content. */
const PARAGRAPH =
  'The city council yesterday adopted a resolution changing traffic patterns in the very centre. ' +
  'The changes cover eight streets, and the first signs will go up later this month. ' +
  'Officials argue that pedestrians and cyclists will benefit most from the rebuild, ' +
  'because the pavements will be widened at the expense of parking spaces along the roadway. ';

function articlePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>A centre without cars - The Daily</title>
    <meta property="og:title" content="A centre without cars" />
    <meta property="og:description" content="Eight streets will change their traffic pattern." />
    <meta property="og:site_name" content="The Example Daily" />
    <style>.ad { display: block }</style>
  </head>
  <body>
    <nav><a href="/section">City</a></nav>
    <article>
      <h1>A centre without cars</h1>
      <p class="author">Anna Kowalska</p>
      <p>${PARAGRAPH}</p>
      <p>${PARAGRAPH}</p>
      <p>${PARAGRAPH}</p>
      <figure>
        <img src="/media/photo.jpg" alt="The street after the rebuild" />
        <figcaption>The street after the rebuild</figcaption>
      </figure>
      <p>${PARAGRAPH}</p>
      <p>More in <a href="../analysis">our analysis</a>.</p>
      <script>window.tracker = 1;</script>
      <iframe src="https://ads.example/banner"></iframe>
    </article>
  </body>
</html>`;
}

describe('sanitizeArticleHtml', () => {
  it('strips script, iframe, style and on* handlers', () => {
    const dirty = `
      <p onclick="steal()" onmouseover="x()">text</p>
      <script>alert(1)</script>
      <iframe src="https://evil.example"></iframe>
      <style>body { display: none }</style>
      <form><input name="password" /></form>
    `;
    const clean = sanitizeArticleHtml(dirty, BASE);

    expect(clean.html).toContain('<p>text</p>');
    expect(clean.html).not.toContain('onclick');
    expect(clean.html).not.toContain('onmouseover');
    expect(clean.html).not.toContain('<script');
    expect(clean.html).not.toContain('<iframe');
    expect(clean.html).not.toContain('<style');
    expect(clean.html).not.toContain('<input');
  });

  it('keeps content tags, strips classes and identifiers', () => {
    const dirty = `
      <h2 id="heading" class="big">Heading</h2>
      <ul><li>one</li><li>two</li></ul>
      <blockquote>a quote</blockquote>
      <pre><code>const x = 1;</code></pre>
      <figure><img src="https://cdn.example/a.png" alt="a" /><figcaption>caption</figcaption></figure>
      <table><thead><tr><th>year</th></tr></thead><tbody><tr><td>2024</td></tr></tbody></table>
    `;
    const clean = sanitizeArticleHtml(dirty, BASE);

    for (const tag of ['h2', 'ul', 'li', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'img', 'table', 'th', 'td']) {
      expect(clean.html).toContain(`<${tag}`);
    }
    expect(clean.html).not.toContain('id="heading"');
    expect(clean.html).not.toContain('class="big"');
  });

  it('turns relative addresses into absolute ones against the page', () => {
    const clean = sanitizeArticleHtml(
      '<p><a href="../other">link</a></p><img src="/media/photo.jpg" alt="p" /><img src="//cdn.example/x.png" alt="x" />',
      BASE,
    );

    expect(clean.html).toContain('href="https://daily.example/other"');
    expect(clean.html).toContain('src="https://daily.example/media/photo.jpg"');
    expect(clean.html).toContain('src="https://cdn.example/x.png"');
  });

  it('external links get rel="noopener noreferrer"', () => {
    const clean = sanitizeArticleHtml('<a href="https://other.example/a">x</a>', BASE);
    expect(clean.html).toContain('rel="noopener noreferrer"');
    expect(clean.html).toContain('target="_blank"');
  });

  it('strips addresses with disallowed schemes', () => {
    const clean = sanitizeArticleHtml(
      '<a href="javascript:alert(1)">click</a><img src="ftp://server/x.png" alt="x" />',
      BASE,
    );

    expect(clean.html).not.toContain('javascript:');
    expect(clean.html).not.toContain('ftp://');
    expect(clean.html).not.toContain('<img');
  });

  it('counts words from the plain text', () => {
    const clean = sanitizeArticleHtml('<p>one two three</p><p>four</p>', BASE);
    expect(clean.text).toBe('one two threefour');
    expect(clean.wordCount).toBe(3);
  });
});

describe('extractFromHtml', () => {
  it('extracts the article, the metadata and the reading time', () => {
    const outcome = extractFromHtml(articlePage(), BASE);

    expect(outcome.kind).toBe('article');
    if (outcome.kind !== 'article') return;

    const { article } = outcome;
    expect(article.title).toContain('A centre without cars');
    expect(article.siteName).toBe('The Example Daily');
    expect(article.lang).toBe('en');
    expect(article.resolvedUrl).toBe(BASE);
    // The addresses of the icon travel with the result; the bytes are fetched
    // by whoever can reach the site (see `lib/favicon.ts`).
    expect(article.faviconUrls).toEqual(['https://daily.example/favicon.ico']);

    // the content went through sanitization
    expect(article.html).not.toContain('<script');
    expect(article.html).not.toContain('<iframe');
    expect(article.html).toContain('src="https://daily.example/media/photo.jpg"');
    expect(article.html).toContain('href="https://daily.example/analysis"');

    // wordCount and reading time are computed from the text, not the HTML
    expect(article.wordCount).toBeGreaterThan(100);
    expect(article.estReadingMinutes).toBe(Math.max(1, Math.round(article.wordCount / 200)));
    expect(article.text).not.toContain('<');
  });

  it('with no article, returns an entry built from og:description', () => {
    const outcome = extractFromHtml(
      `<!doctype html><html lang="en"><head>
         <title>Dashboard</title>
         <meta property="og:title" content="Customer dashboard" />
         <meta property="og:description" content="Sign in to see your data." />
       </head><body><nav><a href="/a">a</a></nav><div id="app"></div></body></html>`,
      'https://dashboard.example/',
    );

    expect(outcome.kind).toBe('stub');
    if (outcome.kind !== 'stub') return;

    expect(outcome.problem).toBe('no-article');
    expect(outcome.stub.title).toBe('Customer dashboard');
    expect(outcome.stub.excerpt).toBe('Sign in to see your data.');
    expect(outcome.stub.lang).toBe('en');
    expect(outcome.stub.resolvedUrl).toBe('https://dashboard.example/');
    expect(outcome.stub.faviconUrls).toEqual(['https://dashboard.example/favicon.ico']);
  });

  it('refuses an empty document', () => {
    const outcome = extractFromHtml('<!doctype html><html><body></body></html>', BASE);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.problem).toBe('empty-document');
  });
});

describe('extractFromDocument', () => {
  it('refuses a document that is not HTML (a PDF)', () => {
    const doc = new DOMParser().parseFromString('<html><body>x</body></html>', 'text/html');
    // jsdom cannot build a PDF document - we swap the type alone, because it is
    // the only thing the refusal depends on.
    Object.defineProperty(doc, 'contentType', { value: 'application/pdf' });

    const outcome = extractFromDocument(doc, 'https://example.com/report.pdf');

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.problem).toBe('unsupported-document');
    expect(outcome.message).toContain('PDF');
  });

  it('does not touch the document it works on', () => {
    const doc = new DOMParser().parseFromString(articlePage(), 'text/html');
    const before = doc.body.innerHTML;

    extractFromDocument(doc, BASE);

    // Readability rearranges and removes nodes - it must get a clone, not the
    // live page.
    expect(doc.body.innerHTML).toBe(before);
  });
});

describe('checkPageUrl', () => {
  it('lets http(s) through', () => {
    expect(checkPageUrl('https://example.com/a')).toBeNull();
    expect(checkPageUrl('http://example.com/a')).toBeNull();
  });

  it('refuses a PDF and schemes outside http(s)', () => {
    expect(checkPageUrl('https://example.com/report.pdf')).toContain('PDF');
    expect(checkPageUrl('https://example.com/REPORT.PDF')).toContain('PDF');
    expect(checkPageUrl('file:///C:/file.html')).toContain('http(s)');
    expect(checkPageUrl('about:blank')).toContain('http(s)');
    expect(checkPageUrl('chrome://extensions')).toContain('http(s)');
    expect(checkPageUrl('not-an-address')).toContain('do not recognize');
  });
});
