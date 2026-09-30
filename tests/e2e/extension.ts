import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base, chromium, type BrowserContext } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist/chrome/', import.meta.url));

function prepareExtension(origins: readonly string[]): string {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('No dist/chrome - build it first: npm run build:chrome');
  }

  const dir = mkdtempSync(join(tmpdir(), 'savely-e2e-'));
  cpSync(DIST, dir, { recursive: true });

  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest['host_permissions'] = [...origins];
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');

  return dir;
}

export function extensionTest(origins: readonly string[] = ['<all_urls>']) {
  return base.extend<{ context: BrowserContext; extensionId: string }>({
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
      const extension = prepareExtension(origins);
      const context = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });

      await use(context);

      await context.close();
      rmSync(extension, { recursive: true, force: true });
    },

    extensionId: async ({ context }, use) => {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await use(new URL(worker.url()).host);
    },
  });
}

export const test = extensionTest();

export { expect } from '@playwright/test';
