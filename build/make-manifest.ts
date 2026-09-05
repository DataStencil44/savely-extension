/**
 * One base (src/manifest.base.json) -> two manifests:
 *   dist/chrome/manifest.json   (MV3 service worker)
 *   dist/firefox/manifest.json  (MV3 event page + browser_specific_settings)
 *
 * The differences between engines live ONLY here - the rest of the code is
 * shared and calls APIs through `browser.*` from webextension-polyfill
 * (CLAUDE.md 5).
 *
 * Run automatically as a Vite plugin after the bundle closes (see
 * `manifestPlugin` at the bottom of the file).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export type Target = 'chrome' | 'firefox';

/** A placeholder - replace with the real ID before publishing on AMO. */
const GECKO_ID = 'savely@example.invalid';

/**
 * Firefox 128 was the first ESR with full MV3, but the floor is raised by
 * `data_collection_permissions` (below): only 140 understands that key, and AMO
 * requires it from new add-ons. 140 is also the current ESR, so we lose nobody
 * who still receives security fixes.
 */
const GECKO_MIN_VERSION = '140.0';

/** The same key reached Firefox for Android only in 142. */
const GECKO_ANDROID_MIN_VERSION = '142.0';

type Manifest = Record<string, unknown>;

interface MakeManifestOptions {
  /** The package root (the one with package.json). */
  rootDir: string;
  /** The target's output directory, e.g. dist/chrome. */
  outDir: string;
  target: Target;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

/** The base plus a per-engine overlay. A pure function - easy to test. */
export function buildManifest(base: Manifest, target: Target): Manifest {
  if (target === 'firefox') {
    return {
      ...base,
      // Firefox MV3 does not support background.service_worker - it uses an event page.
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      // Without a stable ID Firefox refuses to install MV3; without
      // `gecko_android` AMO will not consider the add-on compatible with
      // Firefox for Android (CLAUDE.md 5.2).
      browser_specific_settings: {
        gecko: {
          id: GECKO_ID,
          strict_min_version: GECKO_MIN_VERSION,
          // AMO requires an explicit declaration of collected data. Savely
          // collects none - and that is the substance of this declaration, not
          // a formality (see "What we deliberately do NOT do" in CLAUDE.md).
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

  // Chromium: the service worker has no DOM, so parsing HTML fetched in the
  // background (path B) goes through an offscreen document. Firefox has a DOM
  // on its background page and does not know this permission - hence only here.
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

/** Builds the manifest from the base and writes it to `outDir/manifest.json`. */
export function writeManifest({ rootDir, outDir, target }: MakeManifestOptions): Manifest {
  const base = readJson(resolve(rootDir, 'src/manifest.base.json'));
  const pkg = readJson(resolve(rootDir, 'package.json'));

  // The version has one source of truth - package.json. The entry in the base
  // is only a default, so that the file is a valid manifest on its own.
  const version = typeof pkg['version'] === 'string' ? pkg['version'] : base['version'];
  const manifest = buildManifest({ ...base, version }, target);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}

/**
 * A Vite plugin: generates the manifest after the bundle is built.
 * `rootDir` and `outDir` come from vite.config.ts, because Vite bundles this
 * file together with the config and `import.meta.url` would no longer point
 * at build/.
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
