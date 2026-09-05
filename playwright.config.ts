/**
 * E2E: Chromium with the extension loaded (see tests/e2e/extension.ts).
 *
 * Firefox is deliberately absent - Playwright cannot load a temporary MV3
 * add-on into Gecko. The Firefox side is guarded by `web-ext lint` in CI and by
 * `npm run start:firefox` during manual work.
 */
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 5177);

export default defineConfig({
  testDir: './tests/e2e',
  // The extension lives in one persistent profile - parallel tabs of the same
  // profile would trample each other's IndexedDB.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
  },

  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `http://127.0.0.1:${String(PORT)}/article.html`,
    reuseExistingServer: process.env['CI'] === undefined,
    stdout: 'ignore',
  },
});
