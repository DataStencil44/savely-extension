/**
 * Ustawienia czytnika w `storage.sync`.
 *
 * To jedyne dane, które świadomie wychodzą poza urządzenie - ale przez własną
 * synchronizację przeglądarki, nie przez nasz serwer (bo go nie ma). Gdyby
 * `storage.sync` był niedostępny (Firefox bez konta, wyłączona synchronizacja),
 * schodzimy na `storage.local`: lepiej trzymać ustawienia lokalnie niż zgubić.
 *
 * Dane ze storage traktujemy jak dane z zewnątrz - każde pole przechodzi przez
 * walidację i zaciskanie zakresu (CLAUDE.md 3).
 */
import browser from 'webextension-polyfill';

export type FontFamily = 'serif' | 'sans' | 'dyslexia';
export type Theme = 'light' | 'dark' | 'sepia' | 'auto';

export interface ReaderSettings {
  /** Rozmiar tekstu w px. */
  fontSize: number;
  fontFamily: FontFamily;
  /** Szerokość kolumny w znakach (`ch`). ~68 to komfortowa długość wiersza. */
  columnWidth: number;
  theme: Theme;
  /** Gdy `false`, obrazki z oryginału nie są pobierane - zero ruchu na zewnątrz. */
  remoteImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'serif',
  columnWidth: 68,
  theme: 'auto',
  remoteImages: true,
};

export const FONT_SIZE_RANGE = { min: 14, max: 26 } as const;
export const COLUMN_WIDTH_RANGE = { min: 48, max: 92 } as const;

const STORAGE_KEY = 'reader-settings';

const FAMILIES: readonly string[] = ['serif', 'sans', 'dyslexia'];
const THEMES: readonly string[] = ['light', 'dark', 'sepia', 'auto'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Braki i śmieci zastępujemy domyślnymi - ustawienia nigdy nie mają wywrócić czytnika. */
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
    theme: typeof theme === 'string' && THEMES.includes(theme) ? (theme as Theme) : DEFAULT_SETTINGS.theme,
    remoteImages: typeof remoteImages === 'boolean' ? remoteImages : DEFAULT_SETTINGS.remoteImages,
  };
}

async function area(): Promise<browser.Storage.StorageArea> {
  try {
    // Sam odczyt wystarczy, żeby sprawdzić, czy obszar w ogóle działa.
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
    // Brak zapisu nie może przerwać czytania - ustawienie zadziała do końca sesji.
  }

  return next;
}

/** Zmiana ustawień w innej karcie ma się przenieść tutaj bez przeładowania. */
export function onSettingsChanged(listener: (settings: ReaderSettings) => void): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' && areaName !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (change === undefined) return;
    listener(parseSettings(change.newValue));
  });
}
