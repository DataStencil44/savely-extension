import browser from 'webextension-polyfill';

import { isRecord } from './unknown';

export type FontFamily = 'serif' | 'sans' | 'dyslexia';
export type Theme = 'light' | 'dark' | 'sepia' | 'auto';

export interface ReaderSettings {
  fontSize: number;
  fontFamily: FontFamily;
  columnWidth: number;
  theme: Theme;
  remoteImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'serif',
  columnWidth: 68,
  theme: 'light',
  remoteImages: true,
};

export const FONT_SIZE_RANGE = { min: 14, max: 26 } as const;
export const COLUMN_WIDTH_RANGE = { min: 48, max: 92 } as const;

const STORAGE_KEY = 'reader-settings';

const FAMILIES: readonly string[] = ['serif', 'sans', 'dyslexia'];
const THEMES: readonly Theme[] = ['light', 'dark', 'sepia', 'auto'];

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function parseSettings(value: unknown): ReaderSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS };

  const fontSize = value['fontSize'];
  const fontFamily = value['fontFamily'];
  const columnWidth = value['columnWidth'];
  const theme = value['theme'];
  const remoteImages = value['remoteImages'];

  return {
    fontSize:
      typeof fontSize === 'number' && Number.isFinite(fontSize)
        ? clamp(fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max)
        : DEFAULT_SETTINGS.fontSize,
    fontFamily:
      typeof fontFamily === 'string' && FAMILIES.includes(fontFamily)
        ? (fontFamily as FontFamily)
        : DEFAULT_SETTINGS.fontFamily,
    columnWidth:
      typeof columnWidth === 'number' && Number.isFinite(columnWidth)
        ? clamp(columnWidth, COLUMN_WIDTH_RANGE.min, COLUMN_WIDTH_RANGE.max)
        : DEFAULT_SETTINGS.columnWidth,
    theme: isTheme(theme) ? theme : DEFAULT_SETTINGS.theme,
    remoteImages: typeof remoteImages === 'boolean' ? remoteImages : DEFAULT_SETTINGS.remoteImages,
  };
}

async function area(): Promise<browser.Storage.StorageArea> {
  try {
    await browser.storage.sync.get(STORAGE_KEY);
    return browser.storage.sync;
  } catch {
    return browser.storage.local;
  }
}

export async function loadSettings(): Promise<ReaderSettings> {
  try {
    const store = await area();
    const stored = await store.get(STORAGE_KEY);
    return parseSettings(stored[STORAGE_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<ReaderSettings>): Promise<ReaderSettings> {
  const current = await loadSettings();
  const next = parseSettings({ ...current, ...patch });

  try {
    const store = await area();
    await store.set({ [STORAGE_KEY]: next });
  } catch {
    // ignore
  }

  return next;
}

export function onSettingsChanged(listener: (settings: ReaderSettings) => void): void {
  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' && areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (change === undefined) return;
      listener(parseSettings(change.newValue));
    });
  } catch {
    // ignore
  }
}
