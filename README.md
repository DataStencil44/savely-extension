# Savely

Read-it-later bez backendu. Zapisujesz stronę jednym kliknięciem, Savely
wyciąga z niej czystą treść i pozwala ją przeczytać offline — we własnym
czytniku, z podświetleniami i notatkami. Wszystko zostaje na Twoim urządzeniu:
**żadnego serwera, konta, chmury ani telemetrii**.

Manifest V3, jedno źródło → dwa artefakty: Chromium (Chrome, Brave, Vivaldi,
Edge, Opera) i Firefox (desktop + Android).

---

## Status funkcji

| Obszar | Stan | Co dokładnie |
|---|---|---|
| Zapis strony | ✅ | pasek narzędzi, menu kontekstowe (strona i link), skrót `Ctrl+Shift+S` |
| Ekstrakcja treści | ✅ | `@mozilla/readability` na żywym DOM-ie karty; zapis linku w tle przez `fetch` + dokument offscreen (Chromium) |
| Sanityzacja | ✅ | DOMPurify, lista dozwolonych tagów, `javascript:`/`data:text/html` odrzucane, testy na zestawie wektorów XSS |
| Baza lokalna | ✅ | IndexedDB (`idb`), sześć magazynów, jawne migracje, schemat v5 |
| Lista | ✅ | wirtualizacja, zakładki (inbox/ulubione/archiwum), tagi, pełnotekstowe wyszukiwanie (`flexsearch`), skróty klawiszowe, cofanie usunięcia, ikona strony na karcie |
| Czytnik | ✅ | typografia (rozmiar, krój, szerokość, motywy jasny/ciemny/sepia/auto), pasek postępu, pozycja scrolla, podświetlenia z notatkami, auto-oznaczanie po 90%, tryb bez obrazków zdalnych |
| Przenośność danych | ✅ | eksport JSON i zakładek Netscape, import JSON i CSV z Pocketa, dobowe kopie metadanych, strona opcji z licznikami i kasowaniem bazy |
| Synchronizacja urządzeń | ✅ | opcjonalna, domyślnie wyłączona; wymienny `SyncProvider`, na start prywatny GitHub Gist (patrz niżej) |
| Ustawienia | ✅ | `storage.sync` z fallbackiem na `storage.local` |
| Firefox na Androida | ✅ | ten sam kod, UI od 360 px, wejście do opcji także z listy |
| Wysyłka na Kindle | ❌ | poza zakresem — wymagałaby serwera pocztowego |
| Własny serwer / konto Savely | ❌ | świadomie — synchronizacja idzie przez miejsce należące do Ciebie, nie przez nas |
| Szyfrowanie danych synchronizacji | ❌ | dane w Gistcie są prywatne, ale nieszyfrowane (patrz niżej) |
| Safari | ❌ | poza zakresem |
| Chrome na Androidzie | ❌ | przeglądarka nie obsługuje rozszerzeń |
| Tłumaczenia UI | ❌ | interfejs wyłącznie po polsku (brak `_locales`) |
| AI, podsumowania, TTS | ❌ | poza zakresem MVP |

---

## Praca z repo

```bash
npm ci
npm run build           # dist/chrome + dist/firefox
npm run check           # lint + typecheck + testy jednostkowe
```

### Chromium

```bash
npm run dev:chrome      # build w trybie watch
```
`chrome://extensions` → tryb dewelopera → **Load unpacked** → `dist/chrome`.
Po zmianie w kodzie kliknij „Reload" na kafelku rozszerzenia.

### Firefox (desktop)

Dwa terminale — build w watchu i `web-ext`, który sam przeładowuje dodatek po
każdej zmianie w `dist/firefox`:

```bash
npm run dev:firefox     # terminal 1: build w trybie watch
npm run start:firefox   # terminal 2: web-ext run + auto-reload
```

### Firefox na Androidzie

Wymaga włączonego debugowania USB na telefonie, `adb` w `PATH` i Firefoksa
(Nightly/Beta/Release) z włączoną opcją debugowania zdalnego:

```bash
npm run dev:firefox
npm run start:android
# przy kilku podłączonych urządzeniach:
npm run start:android -- --android-device <ID z `adb devices`>
```

---

## Polecenia

| Polecenie | Co robi |
|---|---|
| `npm run dev:chrome` / `dev:firefox` | build w trybie watch do `dist/<target>` |
| `npm run build` | produkcyjny build obu wariantów |
| `npm run build:chrome` / `build:firefox` | pojedynczy wariant |
| `npm run start:firefox` | `web-ext run` na `dist/firefox` z auto-reloadem |
| `npm run start:android` | to samo z `--target firefox-android` |
| `npm test` / `npm run test:watch` | testy jednostkowe (Vitest) |
| `npm run e2e` | testy e2e (Playwright + Chromium z załadowanym rozszerzeniem) |
| `npm run e2e:install` | pobiera Chromium dla Playwrighta |
| `npm run lint` / `lint:fix` | ESLint po `src/`, `build/`, `tests/` |
| `npm run lint:ext` | `web-ext lint` na `dist/firefox` (wymaga wcześniejszego builda) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | lint + typecheck + testy |
| `npm run pack` | `artifacts/chrome.zip` i `artifacts/firefox.zip` |
| `npm run clean` | usuwa `dist/` i `artifacts/` |

---

## Synchronizacja między urządzeniami

Opcjonalna, domyślnie wyłączona, bez naszego serwera. Włącza się na stronie
opcji (⚙ na liście albo `about:addons` / `chrome://extensions`).

### GitHub Gist — jak to działa

1. Wygeneruj token: **github.com → Settings → Developer settings → Personal
   access tokens**. Klasyczny token potrzebuje wyłącznie uprawnienia `gist`;
   fine-grained — `Gists: read and write`.
2. Wklej go w opcjach i kliknij **Połącz**. Przy pierwszym połączeniu
   przeglądarka zapyta o dostęp do `api.github.com` — bez tego nic nie ruszy.
3. Savely znajdzie istniejący gist Savely na Twoim koncie albo utworzy nowy,
   prywatny, przy pierwszej synchronizacji. Drugie urządzenie z tym samym
   tokenem podepnie się do tego samego gista.
4. **Synchronizuj teraz** działa ręcznie; przełącznik uruchamia alarm co 30 minut.

W gistcie lądują dwa pliki: `savely-sync.json` (metadane — adresy, tytuły, tagi,
podświetlenia, groby po skasowanych pozycjach; czytelny JSON) oraz
`savely-contents.json.gz.base64` (treści artykułów, gzip + base64).

### Co musisz wiedzieć o prywatności

**Prywatny gist nie jest zaszyfrowany.** Nie jest indeksowany i nie widać go na
Twoim profilu, ale każdy, kto ma ten token albo dostęp do Twojego konta GitHub,
przeczyta wszystko, co zapisałeś — łącznie z pełną treścią artykułów. Token
zostaje w `storage.local` na tym urządzeniu i **nigdy** nie trafia do
`storage.sync`, więc nie wędruje między przeglądarkami. „Rozłącz" kasuje token
z urządzenia i nie rusza danych w gistcie ani lokalnych.

### Rozwiązywanie konfliktów

- Tożsamość pozycji to **znormalizowany adres** (bez `utm_*`), nie identyfikator.
- Pola pozycji: wygrywa strona z nowszym `updatedAt` (remis → lokalna).
- **Tagi i podświetlenia się sumują** — nigdy nie nadpisują. Przy tym samym
  cytacie wygrywa wersja z notatką.
- Treść idzie za własnym `updatedAt`, niezależnie od metadanych.
- Kasowanie zostawia grób. Pozycja znika na drugim urządzeniu, chyba że ktoś ją
  tam zmienił **po** kasowaniu — wtedy wraca, bo świadoma edycja jest młodsza.
- Gdy drugie urządzenie zsynchronizowało się w międzyczasie, zapis jest
  przerywany z komunikatem zamiast nadpisywać cudze dane — wystarczy kliknąć
  jeszcze raz.

### Ograniczenia

- Gist ma praktyczny limit rozmiaru; przy pliku powyżej ~9 MB Savely odmówi
  wysyłki i powie o tym wprost (spakowana treść kilkuset artykułów mieści się
  spokojnie).
- Nie ma szyfrowania end-to-end ani historii wersji po naszej stronie —
  historię prowadzi sam Gist.
- Automat chodzi tylko wtedy, gdy przeglądarka działa.

### Dopisanie własnego providera

`SyncProvider` (`src/lib/sync/types.ts`) dostaje nazwane pliki tekstowe
i nieprzezroczysty znacznik wersji — nic więcej. Provider „lokalny folder"
(File System Access API, Chrome-only) to jeden nowy plik obok `github-gist.ts`
i jedna linia w `src/lib/sync/index.ts`; jego `prompt.kind: 'picker'` sprawi, że
opcje pokażą przycisk wyboru folderu zamiast pola na token, a scalanie, alarm
i reszta UI nie zauważą różnicy.

## Testy

**Jednostkowe (Vitest, `src/**/*.test.ts`)** — obok kodu, który testują:

- `lib/db.test.ts` — schemat, migracje przyrostowe, deduplikacja po adresie,
  paginacja keysetem, scalanie importu, atomowość, kopie
- `lib/sanitize.test.ts` — zestaw wektorów XSS (script, `onerror`, `svg onload`,
  `javascript:` w pięciu zapisach, `data:text/html`, `srcdoc`, mXSS…);
  asercje idą po gotowym DOM-ie, nie po stringu
- `lib/backup.test.ts` — formaty eksportu, walidacja importu, parser CSV Pocketa
- `lib/sync/*.test.ts` — scalanie (LWW, sumy tagów i podświetleń, groby),
  ładunek gzip+base64 i jego uszkodzone warianty, provider Gist z podstawionym
  `fetch` (token nie wychodzi poza `storage.local`, wyścig kończy się błędem),
  oraz przejście „dwóch urządzeń" na prawdziwej bazie
- `lib/extract.test.ts`, `lib/search.test.ts`, `lib/settings.test.ts`
- `ui/reader/highlight.test.ts` — offsety podświetleń i odnajdywanie cytatu po
  zmianie treści
- `ui/list/*.test.ts`, `ui/reader/reader.test.ts`, `ui/options/options.test.ts` —
  widoki montowane na jsdom z prawdziwego HTML-a

**E2E (Playwright, `tests/e2e/`)** — Chromium z załadowanym rozszerzeniem:
zapis strony z lokalnego fixture'a, pojawienie się jej na liście, otwarcie
w czytniku, brak ładunków XSS w treści, brak duplikatu przy ponownym zapisie.

```bash
npm run e2e:install     # raz
npm run build:chrome
npm run e2e
```

E2E ładuje **kopię** `dist/chrome` z `<all_urls>` przeniesionym do
`host_permissions` — w automatyzacji nie ma gestu użytkownika ani okna zgody.
Produkcyjny build zostaje bez zmian.

Firefoksa w e2e nie ma: Playwright nie potrafi załadować tymczasowego dodatku
MV3 do Gecko. Tę stronę pilnują `npm run lint:ext` w CI i `npm run start:firefox`
przy pracy ręcznej.

**CI** (`.github/workflows/ci.yml`): lint → typecheck → testy → build obu
wariantów → `web-ext lint`, osobne zadanie e2e, a przy tagu `v*` build, paczki
i wydanie GitHub z `chrome.zip` i `firefox.zip`.

### Znane ostrzeżenia `web-ext lint`

Zero błędów jest warunkiem przejścia CI. Zostają cztery ostrzeżenia, wszystkie
w kodzie zależności i wszystkie nieszkodliwe:

- `DANGEROUS_EVAL` w `list.js` — `flexsearch` ma w bundlu ścieżkę dla Web
  Workera, która składa funkcje ze stringów. Nie używamy trybu workera, więc
  ten kod nigdy się nie wykonuje (a CSP MV3 i tak by na to nie pozwoliło).
- `UNSAFE_VAR_ASSIGNMENT` ×3 — przypisania do `innerHTML` wewnątrz DOMPurify
  i Readability, czyli w samym sanityzatorze i parserze. Nasz kod wstawia treść
  wyłącznie przez `RETURN_DOM_FRAGMENT` + `append()`.

---

## Publikacja

Wersja ma jedno źródło prawdy: `package.json` → manifest. Wydanie zaczyna się od
`npm version <patch|minor|major>` i pushu tagu `vX.Y.Z`; CI zbuduje paczki
i utworzy wydanie GitHub. Do sklepów wysyłasz pliki z tego wydania.

### addons.mozilla.org (Firefox + Firefox na Androida)

1. **Ustaw prawdziwe ID.** W `build/make-manifest.ts` `GECKO_ID` to placeholder
   `savely@example.invalid`. Przed pierwszą wysyłką zamień go na ID z własnej
   domeny albo adres e-mail (np. `savely@twojadomena.pl`). ID jest na zawsze —
   zmiana oznacza nowy dodatek.
2. `npm run build && npm run pack` → `artifacts/firefox.zip`.
3. AMO → *Submit a New Add-on* → *On this site* → wgraj `firefox.zip`.
4. **Wgraj źródła.** Kod jest bundlowany i minifikowany, więc AMO wymaga
   archiwum źródeł (repo bez `node_modules/`, `dist/` i `artifacts/`) plus
   instrukcji budowania: Node 20, `npm ci`, `npm run build:firefox`, wynik
   w `dist/firefox`.
5. **Zbieranie danych: żadne.** Manifest deklaruje
   `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]`
   — to samo zaznacz w formularzu.
6. **Uzasadnij uprawnienia** w polu dla recenzenta: `activeTab` + `scripting`
   (wstrzyknięcie content scriptu na żądanie), `storage`/`unlimitedStorage`
   (IndexedDB z treścią artykułów), `downloads` (eksport kopii), `alarms`
   (dobowa kopia metadanych i opcjonalna synchronizacja), `contextMenus`,
   `notifications`, `optional_host_permissions`: `<all_urls>` (pobranie linku)
   oraz `https://api.github.com/*` (opcjonalna synchronizacja) — o oba prosimy
   runtime'owo, z gestu użytkownika.
7. Wersja minimalna to Firefox 140 (desktop) i 142 (Android) — tego wymaga klucz
   `data_collection_permissions`.

### Chrome Web Store

1. Konto dewelopera CWS (jednorazowa opłata rejestracyjna).
2. `npm run build && npm run pack` → `artifacts/chrome.zip`.
3. Dashboard → *Add new item* → wgraj `chrome.zip`.
4. W zakładce *Privacy practices* zadeklaruj brak zbierania danych i uzasadnij
   każde uprawnienie (lista jak wyżej + `offscreen`, którego wariant Chromium
   używa do parsowania HTML-a pobranego w tle — service worker nie ma DOM-u).
5. Podaj politykę prywatności (wystarczy jedna strona: „dane nie opuszczają
   urządzenia poza eksportem, który użytkownik sam zapisuje").
6. Wyślij do recenzji. Rozszerzenia z `<all_urls>` — nawet opcjonalnym — bywają
   sprawdzane dłużej.

---

## Prywatność

Savely nie ma serwera i nie wysyła niczego w tło. Ruch sieciowy powstaje tylko
wtedy, gdy Ty go wywołasz:

- pobranie strony, którą zapisujesz (albo z otwartej karty, albo `fetch`-em przy
  zapisie linku),
- obrazki z oryginału, wyświetlane w czytniku — do wyłączenia jednym
  przełącznikiem („nie ładuj obrazków zdalnych"),
- synchronizacja ustawień czytnika przez `storage.sync`, czyli mechanizm samej
  przeglądarki, jeśli masz w niej włączone konto,
- synchronizacja zapisanych pozycji — **tylko gdy sam ją włączysz** i tylko do
  miejsca, które wskażesz (patrz „Synchronizacja między urządzeniami").

Zero telemetrii, zero analityki, zero zewnętrznych czcionek i CDN-ów. Wszystkie
zależności są w paczce; CSP rozszerzenia zostaje domyślne i restrykcyjne.

---

## Licencja

MIT.
