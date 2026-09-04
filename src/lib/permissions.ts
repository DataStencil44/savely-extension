/**
 * Host permissions proszone runtime'owo.
 *
 * W Firefoksie MV3 uprawnienia do domen sa domyslnie wstrzymane, wiec pytanie
 * uzytkownika przy pierwszym zapisie z danej strony to **normalny przebieg**,
 * nie blad (CLAUDE.md 5.3). W Chrome, gdy zgoda juz jest, `request()` zwraca
 * `true` bez zadnego okna.
 *
 * `permissions.request()` musi wyjsc z gestu uzytkownika i byc **pierwszym**
 * `await` w obsludze klikniecia - stad ta funkcja jest maksymalnie plaska.
 */
import browser from 'webextension-polyfill';

import { hostPattern } from './page-url';

export async function requestHostAccess(url: string): Promise<boolean> {
  const pattern = hostPattern(url);
  if (pattern === null) return false;

  try {
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    // Brak gestu uzytkownika albo wzorzec spoza `optional_host_permissions`.
    return false;
  }
}
