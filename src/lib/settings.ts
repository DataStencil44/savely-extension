/**
 * Reader settings in `storage.sync`.
 *
 * This is the only data that deliberately leaves the device - but through the
 * browser's own sync, not through our server (there is none). Should
 * `storage.sync` be unavailable (Firefox without an account, sync disabled), we
 * fall back to `storage.local`: better to keep settings locally than to lose
 * them.
 *
 * Data from storage is treated as external - every field goes through
 * validation and range clamping (CLAUDE.md 3).
 */
import browser from 'webextension-polyfill';

export type FontFamily = 'serif' | 'sans' | 'dyslexia';
/** `auto` follows the system; every other value is the user's explicit choice. */
export type Theme = 'light' | 'dark' | 'sepia' | 'auto';

export interface ReaderSettings {
  /** Text size in px. */
  fontSize: number;
  fontFamily: FontFamily;
  /** Column width in characters (`ch`). ~68 is a comfortable line length. */
  columnWidth: number;
  /** The look of the whole UI - the reader, the list and the options page. */
  theme: Theme;
  /** When `false`, images from the original are not fetched - zero outbound traffic. */
  remoteImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'serif',
  columnWidth: 68,
  // Light, not `auto`: the default has to be a look we chose and checked, the
  // same one on every machine. Following the system is one click away.
  theme: 'light',
  remoteImages: true,
};

export const FONT_SIZE_RANGE = { min: 14, max: 26 } as const;
export const COLUMN_WIDTH_RANGE = { min: 48, max: 92 } as const;

const STORAGE_KEY = 'reader-settings';

const FAMILIES: readonly string[] = ['serif', 'sans', 'dyslexia'];
const THEMES: readonly Theme[] = ['light', 'dark', 'sepia', 'auto'];

/** For a theme name read out of the page (a `data-` attribute) rather than typed in code. */
export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Missing and junk values fall back to the defaults - settings must never break the reader. */
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
    // A read alone is enough to check whether the area works at all.
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
    // A failed write must not interrupt reading - the setting holds for this session.
  }

  return next;
}

/** A settings change in another tab should land here without a reload. */
export function onSettingsChanged(listener: (settings: ReaderSettings) => void): void {
  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' && areaName !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (change === undefined) return;
      listener(parseSettings(change.newValue));
    });
  } catch {
    // No change events is a worse experience, not a broken page: the settings
    // that were read at startup keep working until the next reload.
  }
}
