import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Polyfill sprawdza `chrome.runtime.id` już przy ładowaniu modułu. */
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: { id: 'test', lastError: null },
      storage: {
        sync: {
          get: (keys: string | string[], callback: (items: Record<string, unknown>) => void) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            callback(key !== undefined && key in data ? { [key]: data[key] } : {});
          },
          set: (items: Record<string, unknown>, callback: () => void) => {
            Object.assign(data, items);
            callback();
          },
        },
        local: { get: (_k: unknown, cb: (i: unknown) => void) => { cb({}); } },
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return data;
});

const { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings } = await import('./settings');

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('parseSettings', () => {
  it('brak ustawień to wartości domyślne', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nie obiekt')).toEqual(DEFAULT_SETTINGS);
  });

  it('zaciska zakresy zamiast przyjmować bzdury', () => {
    expect(parseSettings({ fontSize: 999 }).fontSize).toBe(26);
    expect(parseSettings({ fontSize: 2 }).fontSize).toBe(14);
    expect(parseSettings({ columnWidth: 1_000 }).columnWidth).toBe(92);
    expect(parseSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('odrzuca nieznane warianty pól wyliczeniowych', () => {
    expect(parseSettings({ theme: 'neon' }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(parseSettings({ fontFamily: 'comic' }).fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    expect(parseSettings({ theme: 'sepia', fontFamily: 'dyslexia' })).toMatchObject({
      theme: 'sepia',
      fontFamily: 'dyslexia',
    });
  });

  it('zachowuje wyłączone obrazki zdalne', () => {
    expect(parseSettings({ remoteImages: false }).remoteImages).toBe(false);
    expect(parseSettings({ remoteImages: 'nie' }).remoteImages).toBe(true);
  });
});

describe('zapis i odczyt', () => {
  it('zapisuje tylko zmienione pola i oddaje komplet', async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);

    const saved = await saveSettings({ theme: 'dark', fontSize: 22 });
    expect(saved).toMatchObject({ theme: 'dark', fontSize: 22, columnWidth: 68 });

    await expect(loadSettings()).resolves.toEqual(saved);
  });

  it('wartość spoza zakresu nie trafia do storage w takiej postaci', async () => {
    const saved = await saveSettings({ columnWidth: 500 });
    expect(saved.columnWidth).toBe(92);
    await expect(loadSettings()).resolves.toMatchObject({ columnWidth: 92 });
  });
});
