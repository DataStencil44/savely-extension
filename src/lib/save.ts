/**
 * Zapis artykulu - dwie sciezki, jeden wspolny ogon.
 *
 * A) `savePageInTab` - strona jest otwarta: content script czyta zywy DOM.
 *    Omija CORS i widzi tresc za loginem, bo czyta to samo, co uzytkownik.
 * B) `saveLinkInBackground` - zapis linku, ktorego nikt nie otworzyl:
 *    `fetch` w tle + parsowanie poza karta. Wymaga zgody na domene.
 *
 * Kazda sciezka to **jedna awaitowana sekwencja**, bez stanu w zmiennych
 * modulowych: gdy Chrome ubije service workera w polowie, nie zostaje po nas
 * nic poza tym, co juz jest w IndexedDB (CLAUDE.md 5.5).
 */
import browser from 'webextension-polyfill';

import { saveItem, setContent } from './db';
import { isOutcomeResponse } from './guards';
import { extractHtmlOutOfBand } from './offscreen';
import { checkPageUrl } from './page-url';
import { requestHostAccess } from './permissions';
import { EXTRACT_REQUEST } from '@/types/messages';
import type { ExtractOutcome } from '@/types/article';

export interface SaveResult {
  ok: boolean;
  /** Komunikat gotowy do pokazania uzytkownikowi. */
  message: string;
  /** Zapis sie udal, ale bez tresci artykulu (wpis ma status 'failed'). */
  degraded: boolean;
  itemId: string | null;
}

function fail(message: string): SaveResult {
  return { ok: false, message, degraded: false, itemId: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'nieznany blad';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Wspolny ogon obu sciezek: wynik ekstrakcji -> baza.
 *
 * `requestUrl` to adres, ktory zapisywal uzytkownik; `resolvedUrl` z wyniku
 * moze byc inny (przekierowanie) i to on decyduje o deduplikacji.
 */
async function persist(outcome: ExtractOutcome, requestUrl: string): Promise<SaveResult> {
  if (outcome.kind === 'refused') {
    return fail(outcome.message);
  }

  if (outcome.kind === 'stub') {
    const { stub } = outcome;
    const item = await saveItem({
      url: requestUrl,
      resolvedUrl: stub.resolvedUrl,
      title: stub.title,
      excerpt: stub.excerpt,
      siteName: stub.siteName,
      lang: stub.lang,
      status: 'failed',
    });

    return {
      ok: true,
      degraded: true,
      itemId: item.id,
      message: `Zapisalem sam wpis: ${stub.title}. Tresci nie udalo sie wyciagnac.`,
    };
  }

  const { article } = outcome;

  // Najpierw wpis (status 'pending'), potem tresc - `setContent` przestawia
  // pozycje na 'ready' w tej samej transakcji. Gdy worker zginie miedzy tymi
  // krokami, na liscie zostaje wpis w stanie 'pending', a nie polowa danych.
  const item = await saveItem({
    url: requestUrl,
    resolvedUrl: article.resolvedUrl,
    title: article.title,
    excerpt: article.excerpt,
    byline: article.byline,
    siteName: article.siteName,
    lang: article.lang,
    wordCount: article.wordCount,
    estReadingMinutes: article.estReadingMinutes,
    status: 'pending',
  });

  await setContent(item.id, {
    html: article.html,
    text: article.text,
    contentHash: await sha256Hex(article.text),
  });

  return {
    ok: true,
    degraded: false,
    itemId: item.id,
    message: `Zapisano: ${article.title}`,
  };
}

/** Sciezka A: strona otwarta w karcie. */
export async function savePageInTab(tabId: number, url: string): Promise<SaveResult> {
  const problem = checkPageUrl(url);
  if (problem !== null) return fail(problem);

  let outcome: ExtractOutcome;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const response: unknown = await browser.tabs.sendMessage(tabId, { type: EXTRACT_REQUEST });
    if (!isOutcomeResponse(response)) {
      return fail('Karta odpowiedziala czyms, czego nie rozumiem - sprobuj odswiezyc strone.');
    }
    outcome = response.outcome;
  } catch (error) {
    return fail(
      `Nie moge odczytac tej karty (${errorMessage(error)}). Strony wewnetrzne przegladarki, sklep z dodatkami i PDF-y sa poza zasiegiem.`,
    );
  }

  return persist(outcome, url);
}

/**
 * Sciezka B: link z menu kontekstowego, strona nieotwarta.
 *
 * `requestHostAccess` jest pierwszym `await` - w Firefoksie prosba o dostep
 * musi wyjsc prosto z gestu uzytkownika, inaczej zostanie odrzucona.
 */
export async function saveLinkInBackground(url: string): Promise<SaveResult> {
  const problem = checkPageUrl(url);
  if (problem !== null) return fail(problem);

  const granted = await requestHostAccess(url);
  if (!granted) {
    return fail(
      'Bez zgody na dostep do tej domeny nie pobiore tresci. Przy pierwszym zapisie z danej strony to normalne - kliknij jeszcze raz i potwierdz prosbe.',
    );
  }

  let response: Response;
  try {
    // `credentials: 'omit'` - zapis linku nie ma prawa uzywac cookies
    // uzytkownika. Tresc za loginem zapisuje sie sciezka A, z otwartej karty.
    response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  } catch (error) {
    return fail(`Nie udalo sie pobrac strony (${errorMessage(error)}).`);
  }

  if (!response.ok) {
    return fail(`Serwer odpowiedzial ${String(response.status)} - nie mam czego zapisac.`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return fail(
      `Ten adres nie jest strona HTML (${contentType === '' ? 'nieznany typ' : contentType}).`,
    );
  }

  const html = await response.text();

  try {
    const outcome = await extractHtmlOutOfBand(html, response.url === '' ? url : response.url);
    return await persist(outcome, url);
  } catch (error) {
    return fail(`Nie udalo sie przetworzyc strony (${errorMessage(error)}).`);
  }
}
