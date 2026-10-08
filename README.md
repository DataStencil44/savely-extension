# Savely

A read-it-later browser extension with no backend. Save a page with one click,
Savely pulls out the clean article text, and you read it later — offline, in
its own reader, with highlights and notes. Everything stays on your device:
**no server, no account, no cloud, no telemetry**.

Manifest V3, one source → two builds: Chromium (Chrome, Edge, Brave, Vivaldi,
Opera) and Firefox (desktop and Android).

---

## Features

| Area | Status | Details |
|---|---|---|
| Saving | ✅ | toolbar, context menu (page and link), `Ctrl+Shift+S` |
| Extraction | ✅ | `@mozilla/readability` on the tab's live DOM; links saved in the background via `fetch` + an offscreen document (Chromium) |
| Sanitizing | ✅ | DOMPurify with an allow-list, `javascript:` / `data:text/html` rejected, tested against a set of XSS vectors |
| Local database | ✅ | IndexedDB (`idb`) with explicit, incremental migrations |
| List | ✅ | virtualized, inbox / favourites / archive, tags, full-text search (`flexsearch`) with `tag:name` in the search box, keyboard shortcuts, undo delete, site icons, theme toggle (`d`) |
| Themes | ✅ | light (default), dark, sepia, system — one setting for the list, options and reader |
| Reader | ✅ | typography (size, font, width, theme), progress bar, scroll position, highlights with notes, marked as read at 90%, optional no-remote-images mode |
| Data portability | ✅ | full backup as ZIP or JSON, Netscape bookmarks export, import of ZIP, JSON and Pocket CSV, daily local backups, storage usage and delete-all on the options page |
| Settings | ✅ | `storage.sync` with a `storage.local` fallback |
| Firefox for Android | ✅ | same code, UI usable from 360 px wide |
| Device sync | ❌ | deliberately left out until it can be end-to-end encrypted; move data between browsers with a ZIP export/import |
| Savely server / account | ❌ | by design — everything stays in the browser |
| Send to Kindle, AI, summaries, TTS | ❌ | out of scope |
| Safari, Chrome for Android | ❌ | out of scope / no extension support |
| UI translations | ❌ | English only |

---

## Install

From the stores (once published): Chrome Web Store and addons.mozilla.org.

From a release: download `chrome.zip` or `firefox.zip` from the
[Releases](../../releases) page.

- **Chromium:** unzip, open `chrome://extensions`, turn on Developer mode,
  **Load unpacked** → the unzipped folder.
- **Firefox:** `about:debugging` → *This Firefox* → **Load Temporary Add-on**
  → `manifest.json` inside the unzipped folder (removed on restart; for a
  permanent install use the AMO version).

---

## Development

Requires Node 20+.

```bash
npm ci
npm run build           # dist/chrome + dist/firefox
npm run check           # lint + typecheck + unit tests
```

### Chromium

```bash
npm run dev:chrome      # watch build
```

`chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome`.
Click **Reload** on the extension card after a change.

### Firefox (desktop)

Two terminals — a watch build and `web-ext`, which reloads the add-on on every
change in `dist/firefox`:

```bash
npm run dev:firefox     # terminal 1
npm run start:firefox   # terminal 2
```

### Firefox for Android

Needs USB debugging on the phone, `adb` in `PATH` and remote debugging enabled
in Firefox:

```bash
npm run dev:firefox
npm run start:android
npm run start:android -- --android-device <ID from `adb devices`>
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev:chrome` / `dev:firefox` | watch build into `dist/<target>` |
| `npm run build` | production build of both targets |
| `npm run build:chrome` / `build:firefox` | a single target |
| `npm run start:firefox` | `web-ext run` on `dist/firefox` with auto-reload |
| `npm run start:android` | the same with `--target firefox-android` |
| `npm test` / `npm run test:watch` | unit tests (Vitest) |
| `npm run e2e` | end-to-end tests (Playwright + Chromium with the extension loaded) |
| `npm run e2e:install` | downloads Chromium for Playwright |
| `npm run lint` / `lint:fix` | ESLint over `src/`, `build/`, `tests/` |
| `npm run lint:ext` | `web-ext lint` on `dist/firefox` (build first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | lint + typecheck + unit tests |
| `npm run release:chrome` | build + `artifacts/chrome.zip` |
| `npm run release:firefox` | build + `artifacts/firefox.zip` + `artifacts/source.zip` |
| `npm run pack` | both store zips from an existing build |
| `npm run pack:source` | `artifacts/source.zip` — sources from `HEAD` for AMO review |
| `npm run clean` | removes `dist/` and `artifacts/` |

---

## Tests

**Unit (Vitest, `src/**/*.test.ts`)** — next to the code they test: database
schema, migrations and import merging, a set of XSS vectors for the sanitizer,
backup formats and the Pocket CSV parser, ZIP read/write, extraction, search,
settings, highlight offsets, and the list, reader and options pages mounted on
jsdom from their real HTML.

**End-to-end (Playwright, `tests/e2e/`)** — Chromium with the extension loaded:
saving a page from a local fixture, seeing it in the list, opening it in the
reader, no XSS payloads in the content, no duplicate on re-save, tags, themes
and site icons.

```bash
npm run e2e:install     # once
npm run build:chrome
npm run e2e
```

The e2e run loads a **copy** of `dist/chrome` with `<all_urls>` moved into
`host_permissions`, because automation has no user gesture for the permission
prompt. The production build is unchanged.

Firefox has no e2e: Playwright cannot load a temporary MV3 add-on into Gecko.
That side is covered by `npm run lint:ext` in CI and `npm run start:firefox`
by hand.

**CI** (`.github/workflows/ci.yml`): lint → typecheck → unit tests → build of
both targets → `web-ext lint`, a separate e2e job, and on a `v*` tag the store
packages and a GitHub release.

### Known `web-ext lint` warnings

Zero errors is the CI pass condition. Eight warnings remain, all inside bundled
dependencies:

- `DANGEROUS_EVAL` ×2 in `list.js` — FlexSearch's Web Worker code path, which
  Savely never enables (and MV3 CSP would block anyway).
- `UNSAFE_VAR_ASSIGNMENT` ×6 (`content.js`, `chunks/extract-*`,
  `chunks/sanitize-*`) — `innerHTML` inside DOMPurify and Readability
  themselves. Savely inserts article HTML only through
  `RETURN_DOM_FRAGMENT` + `append()`.

---

## Publishing

Each store gets its own package, built by its own command:

| Store | Command | Upload | Guide and form texts |
|---|---|---|---|
| Chrome Web Store | `npm run release:chrome` | `artifacts/chrome.zip` | [`store/chrome-web-store.md`](store/chrome-web-store.md) |
| addons.mozilla.org | `npm run release:firefox` | `artifacts/firefox.zip`, `artifacts/source.zip` | [`store/firefox-amo.md`](store/firefox-amo.md) |

Shared privacy policy: [`store/PRIVACY.md`](store/PRIVACY.md).

The version lives in `package.json` and goes into the manifest from there. A
release is `npm version <patch|minor|major>` and a push of the `vX.Y.Z` tag; CI
builds all three packages and creates a GitHub release. `source.zip` is a
`git archive` of `HEAD`, so commit everything before `release:firefox`.

The Firefox build has no `offscreen` page — its event page has a DOM, and the
`offscreen` API exists only in Chromium.

---

## Privacy

Savely has no server and sends nothing in the background. Network traffic
happens only when you cause it:

- loading the page you save (read from the open tab, or `fetch`ed when you save
  a link),
- images from the original page shown in the reader — can be turned off
  ("Don't load remote images"),
- reader settings through `storage.sync`, i.e. the browser's own sync, if you
  are signed in to it.

Saved items are not synced. To move them to another device or browser, export a
ZIP on the options page and import it on the other side.

No telemetry, no analytics, no external fonts or CDNs. All dependencies are
bundled; the extension keeps the default, strict CSP. Full policy:
[`store/PRIVACY.md`](store/PRIVACY.md).

---

## License

[MIT](LICENSE)
