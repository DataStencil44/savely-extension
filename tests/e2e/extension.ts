/**
 * Fixture Playwrighta: Chromium z zaladowanym rozszerzeniem.
 *
 * Rozszerzenia dzialaja wylacznie w kontekscie trwalym (`launchPersistentContext`)
 * i tylko na kanale `chromium` - stad wlasny fixture zamiast domyslnej
 * przegladarki z `use`.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base, chromium, type BrowserContext } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist/chrome/', import.meta.url));

/**
 * Kopia buildu z host permissions wpisanymi na stale.
 *
 * Produkcyjnie `<all_urls>` siedzi w `optional_host_permissions` i jest proszone
 * z gestu uzytkownika (CLAUDE.md 5.3). W automatyzacji nie ma ani gestu, ani
 * kogos, kto klika w okno zgody, wiec test dostaje wariant z `host_permissions`.
 * Produkcyjny `dist/chrome` zostaje nietkniety - to kopia w katalogu tymczasowym.
 */
function prepareExtension(): string {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('Brak dist/chrome - zbuduj najpierw: npm run build:chrome');
  }

  const dir = mkdtempSync(join(tmpdir(), 'savely-e2e-'));
  cpSync(DIST, dir, { recursive: true });

  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest['host_permissions'] = ['<all_urls>'];
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');

  return dir;
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // Playwright wymaga destrukturyzacji fixture'ow w pierwszym argumencie -
  // pusty wzorzec oznacza "nie potrzebuje zadnego".
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const extension = prepareExtension();
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });

    await use(context);

    await context.close();
    rmSync(extension, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    // Service worker tla wstaje sam po zaladowaniu rozszerzenia; jego adres
    // (`chrome-extension://<id>/background.js`) to jedyne zrodlo identyfikatora.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },
});

export { expect } from '@playwright/test';
