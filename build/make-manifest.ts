import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export type Target = 'chrome' | 'firefox';

const GECKO_ID = '{d45c453b-44c5-411b-925a-ec28396362a7}';

const GECKO_MIN_VERSION = '140.0';

const GECKO_ANDROID_MIN_VERSION = '142.0';

type Manifest = Record<string, unknown>;

interface MakeManifestOptions {
  rootDir: string;
  outDir: string;
  target: Target;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

export function buildManifest(base: Manifest, target: Target): Manifest {
  if (target === 'firefox') {
    return {
      ...base,
      background: {
        scripts: ['background.js'],
        type: 'module',
      },
      browser_specific_settings: {
        gecko: {
          id: GECKO_ID,
          strict_min_version: GECKO_MIN_VERSION,
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

export function writeManifest({ rootDir, outDir, target }: MakeManifestOptions): Manifest {
  const base = readJson(resolve(rootDir, 'src/manifest.base.json'));
  const pkg = readJson(resolve(rootDir, 'package.json'));

  const version = typeof pkg['version'] === 'string' ? pkg['version'] : base['version'];
  const manifest = buildManifest({ ...base, version }, target);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}

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
