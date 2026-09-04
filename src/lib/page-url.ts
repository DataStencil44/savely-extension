/**
 * Czyste funkcje o adresach - bez API przegladarki, wiec testowalne bez niej.
 */

/**
 * Adresy, ktorych nie ma sensu tykac. PDF odsiewamy po rozszerzeniu juz tutaj,
 * zeby nie wstrzykiwac skryptu do widoku PDF-a; drugi bezpiecznik
 * (`document.contentType`) siedzi w `extractFromDocument`.
 *
 * Zwraca komunikat dla uzytkownika albo `null`, gdy adres jest w porzadku.
 */
export function checkPageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Nie rozpoznaje adresu tej strony.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Savely zapisuje tylko strony http(s), a to jest ${parsed.protocol}//`;
  }

  if (/\.pdf$/i.test(parsed.pathname)) {
    return 'To jest PDF, a nie strona HTML - Savely nie ma z czego zrobic artykulu.';
  }

  return null;
}

/** Wzorzec dopasowania dla calej domeny, np. `https://example.com/*`. */
export function hostPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}
