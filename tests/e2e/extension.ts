/**
 * A Playwright fixture: Chromium with the extension loaded.
 *
 * Extensions work only in a persistent context (`launchPersistentContext`) and
 * only on the `chromium` channel - hence a custom fixture rather than the
 * default browser from `use`.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base, chromium, type BrowserContext } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist/chrome/', import.meta.url));

/**
 * A copy of the build with the host permissions baked in.
 *
 * In production `<all_urls>` sits in `optional_host_permissions` and is
 * requested from a user gesture (CLAUDE.md 5.3). In automation there is neither
 * a gesture nor anyone to click the consent dialog, so the test gets a variant
 * with `host_permissions`. The production `dist/chrome` is left untouched -
 * this is a copy in a temporary directory.
 *
 * `origins` is what those permissions cover. `<all_urls>` is the convenient
 * default, but a test that cares about what path A can actually reach narrows
 * it to the page's own origin - which is all `activeTab` grants a real user.
 */
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

/** The fixture, for a given set of host permissions. */
export function extensionTest(origins: readonly string[] = ['<all_urls>']) {
  return base.extend<{ context: BrowserContext; extensionId: string }>({
    // Playwright requires destructuring the fixtures in the first argument -
    // an empty pattern means "I need none of them".
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
      // The background service worker starts on its own once the extension
      // loads; its address (`chrome-extension://<id>/background.js`) is the only
      // source of the identifier.
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await use(new URL(worker.url()).host);
    },
  });
}

export const test = extensionTest();

export { expect } from '@playwright/test';
