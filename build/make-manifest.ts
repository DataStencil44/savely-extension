/**
 * Jedna baza (src/manifest.base.json) -> dwa manifesty:
 *   dist/chrome/manifest.json   (MV3 service worker)
 *   dist/firefox/manifest.json  (MV3 event page + browser_specific_settings)
 *
 * Roznice miedzy silnikami zyja WYLACZNIE tutaj - reszta kodu jest wspolna
 * i wola API przez `browser.*` z webextension-polyfill (CLAUDE.md 5).
 *
 * Uruchamiane automatycznie jako plugin Vite po zamknieciu bundla
 * (patrz `manifestPlugin` na dole pliku).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export type Target = 'chrome' | 'firefox';

/** Placeholder - do zmiany na prawdziwe ID przed publikacja na AMO. */
const GECKO_ID = 'savely@example.invalid';

/**
 * Firefox 128 byl pierwszym ESR-em z pelnym MV3, ale prog podnosi
 * `data_collection_permissions` (nizej): ten klucz rozumie dopiero 140, a AMO
 * wymaga go od nowych dodatkow. 140 to zarazem aktualny ESR, wiec nie tracimy
 * nikogo, kto dostaje jeszcze poprawki bezpieczenstwa.
 */
const GECKO_MIN_VERSION = '140.0';

/** Ten sam klucz doszedl do Firefoksa na Androida dopiero w 142. */
const GECKO_ANDROID_MIN_VERSION = '142.0';

type Manifest = Record<string, unknown>;

interface MakeManifestOptions {
  /** Katalog glowny pakietu (ten z package.json). */
  rootDir: string;
  /** Katalog wyjsciowy targetu, np. dist/chrome. */
  outDir: string;
  target: Target;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** Baza + nakladka per silnik. Czysta funkcja - latwa do przetestowania. */
export function buildManifest(base: Manifest, target: Target): Manifest {
  if (target === 'firefox') {
    return {
      ...base,
      // Firefox MV3 nie wspiera background.service_worker - uzywa event page.
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      // Bez stabilnego ID Firefox odmowi instalacji MV3; bez `gecko_android`
      // AMO nie uzna dodatku za zgodny z Firefoksem na Androida (CLAUDE.md 5.2).
      browser_specific_settings: {
        gecko: {
          id: GECKO_ID,
          strict_min_version: GECKO_MIN_VERSION,
          // AMO wymaga jawnej deklaracji zbieranych danych. Savely nie zbiera
          // zadnych - i to jest tresc tej deklaracji, nie formalnosc
          // (patrz "Czego swiadomie NIE robimy" w CLAUDE.md).
          data_collection_permissions: {
            required: ['none'],
          },
        },
        gecko_android: {
          strict_min_version: GECKO_ANDROID_MIN_VERSION,
        },
      },
    };
  }

  // Chromium: service worker nie ma DOM-u, wiec parsowanie HTML-a pobranego
  // w tle (sciezka B) idzie przez dokument offscreen. Firefox ma DOM na
  // stronie tla i tego uprawnienia nie zna - stad tylko tutaj.
  const permissions = Array.isArray(base['permissions'])
    ? [...(base['permissions'] as string[]), 'offscreen']
    : ['offscreen'];

  return {
    ...base,
    permissions,
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    minimum_chrome_version: '109',
  };
}

/** Sklada manifest z bazy i zapisuje go do `outDir/manifest.json`. */
export function writeManifest({ rootDir, outDir, target }: MakeManifestOptions): Manifest {
  const base = readJson(resolve(rootDir, 'src/manifest.base.json'));
  const pkg = readJson(resolve(rootDir, 'package.json'));

  // Wersja ma jedno zrodlo prawdy - package.json. Wpis w bazie jest tylko
  // wartoscia domyslna, zeby plik sam w sobie byl poprawnym manifestem.
  const version = typeof pkg['version'] === 'string' ? pkg['version'] : base['version'];
  const manifest = buildManifest({ ...base, version }, target);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}

/**
 * Plugin Vite: generuje manifest po zbudowaniu bundla.
 * `rootDir` i `outDir` przychodza z vite.config.ts, bo Vite bunduje ten plik
 * razem z configiem i `import.meta.url` nie wskazywalby juz na build/.
 */
export function manifestPlugin(options: MakeManifestOptions): Plugin {
  return {
    name: 'savely:make-manifest',
    apply: 'build',
    closeBundle() {
      writeManifest(options);
      console.log(`[savely] manifest.json -> dist/${options.target}`);
    },
  };
}
