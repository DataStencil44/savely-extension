/**
 * E2E: Chromium z zaladowanym rozszerzeniem (patrz tests/e2e/extension.ts).
 *
 * Firefoksa tu nie ma celowo - Playwright nie potrafi zaladowac tymczasowego
 * dodatku MV3 do Gecko. Strone Firefoksa pilnuja `web-ext lint` w CI
 * i `npm run start:firefox` przy pracy recznej.
 */
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 5177);

export default defineConfig({
  testDir: './tests/e2e',
  // Rozszerzenie zyje w jednym, trwalym profilu - rownolegle karty tego samego
  // profilu deptalyby sobie po IndexedDB.
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
    url: `http://127.0.0.1:${String(PORT)}/artykul.html`,
    reuseExistingServer: process.env['CI'] === undefined,
    stdout: 'ignore',
  },
});
