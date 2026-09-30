import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  it('no settings means the defaults', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('not an object')).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps ranges instead of accepting nonsense', () => {
    expect(parseSettings({ fontSize: 999 }).fontSize).toBe(26);
    expect(parseSettings({ fontSize: 2 }).fontSize).toBe(14);
    expect(parseSettings({ columnWidth: 1_000 }).columnWidth).toBe(92);
    expect(parseSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('rejects unknown variants of enum fields', () => {
    expect(parseSettings({ theme: 'neon' }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(parseSettings({ fontFamily: 'comic' }).fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    expect(parseSettings({ theme: 'sepia', fontFamily: 'dyslexia' })).toMatchObject({
      theme: 'sepia',
      fontFamily: 'dyslexia',
    });
  });

  it('preserves remote images being turned off', () => {
    expect(parseSettings({ remoteImages: false }).remoteImages).toBe(false);
    expect(parseSettings({ remoteImages: 'no' }).remoteImages).toBe(true);
  });
});

describe('saving and loading', () => {
  it('writes only the changed fields and returns the full set', async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);

    const saved = await saveSettings({ theme: 'dark', fontSize: 22 });
    expect(saved).toMatchObject({ theme: 'dark', fontSize: 22, columnWidth: 68 });

    await expect(loadSettings()).resolves.toEqual(saved);
  });

  it('an out-of-range value does not reach storage in that form', async () => {
    const saved = await saveSettings({ columnWidth: 500 });
    expect(saved.columnWidth).toBe(92);
    await expect(loadSettings()).resolves.toMatchObject({ columnWidth: 92 });
  });
});
