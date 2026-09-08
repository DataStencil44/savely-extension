// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The polyfill checks `chrome.runtime.id` as soon as the module loads. */
const store = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const listeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];

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
            for (const listener of listeners) {
              for (const [key, value] of Object.entries(items)) {
                listener({ [key]: { newValue: value } }, 'sync');
              }
            }
            callback();
          },
        },
        local: { get: (_k: unknown, cb: (i: unknown) => void) => { cb({}); } },
        onChanged: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
      },
    },
  });

  return data;
});

const { DEFAULT_SETTINGS } = await import('./settings');
const { THEME_ORDER, applyTheme, initTheme, nextTheme, setTheme } = await import('./theme');

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  delete document.documentElement.dataset['theme'];
});

describe('the theme', () => {
  it('is light until the user says otherwise', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('light');
    expect(THEME_ORDER[0]).toBe('light');
  });

  it('cycles through every theme and comes back round', () => {
    const seen = [nextTheme('light'), nextTheme('dark'), nextTheme('sepia'), nextTheme('auto')];
    expect(seen).toEqual(['dark', 'sepia', 'auto', 'light']);
  });

  it('starts the cycle over on a value it does not know', () => {
    // Settings written by another version must not leave the button stuck.
    expect(nextTheme('neon' as never)).toBe('light');
  });

  it('applying it is one attribute on the root', () => {
    applyTheme('sepia');
    expect(document.documentElement.dataset['theme']).toBe('sepia');
  });

  it('reads the stored theme and follows later changes', async () => {
    await expect(initTheme()).resolves.toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');

    const changes: string[] = [];
    await initTheme((theme) => changes.push(theme));

    await setTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    // Once from the switch itself, once from the storage event another page sees.
    expect(changes).toContain('dark');
  });
});
