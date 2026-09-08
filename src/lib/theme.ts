/**
 * The UI theme - one setting for the whole extension.
 *
 * The theme lives in `ReaderSettings` (`src/lib/settings.ts`), because there is
 * no reason for the reader and the list to disagree about it: the user picks a
 * look once and every page follows. This module is the thin layer between that
 * setting and the DOM - it knows the order of the switcher and the label of
 * each theme, and nothing about storage.
 *
 * Applying a theme is a single attribute on <html>; the palettes are in
 * `src/ui/theme.css` (list, options) and `reader.css` (reader).
 */
import { loadSettings, onSettingsChanged, saveSettings, type Theme } from './settings';

/**
 * The order of the cycle in the one-button switcher: the two everyday themes
 * first, then paper, and "follow the system" last - a user who wants it will
 * look for it, and it is the one option whose result depends on the machine.
 */
export const THEME_ORDER: readonly Theme[] = ['light', 'dark', 'sepia', 'auto'];

export const THEME_LABELS: Readonly<Record<Theme, string>> = {
  light: 'Light',
  dark: 'Dark',
  sepia: 'Sepia',
  auto: 'System',
};

/**
 * One glyph per theme - the switcher is a single button in a tight top bar.
 * The sun carries U+FE0E: without it the system font draws it as a colour
 * emoji, which spills out of a 26 px button and hides its border.
 */
export const THEME_ICONS: Readonly<Record<Theme, string>> = {
  light: '\u2600\uFE0E', // sun
  dark: '\u263E', // moon
  sepia: '\u25A4', // ruled paper
  auto: '\u25D0', // half-filled circle: follows the system
};

export function nextTheme(current: Theme): Theme {
  const at = THEME_ORDER.indexOf(current);
  // An unknown value (an older or newer version of the settings) starts over.
  return THEME_ORDER[(at + 1) % THEME_ORDER.length] ?? 'light';
}

/**
 * `light` is written out rather than left off: the CSS default is light anyway,
 * but a page that says which theme it is showing can be checked in a test and
 * read in devtools without guessing.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = theme;
}

export async function setTheme(theme: Theme): Promise<Theme> {
  const saved = await saveSettings({ theme });
  applyTheme(saved.theme);
  return saved.theme;
}

/**
 * Reads the theme, applies it, and keeps applying it - a switch in another tab
 * (or in the reader) lands here without a reload.
 *
 * The load is asynchronous, so until it finishes the page shows the CSS
 * default, light. That is the default setting too, so the only user who can see
 * a flash is one who chose a dark theme; a synchronous read is not on offer
 * (extension storage has no sync API, and MV3 forbids an inline script that
 * could run before the stylesheet paints).
 */
export async function initTheme(onChange?: (theme: Theme) => void): Promise<Theme> {
  const settings = await loadSettings();
  applyTheme(settings.theme);
  onChange?.(settings.theme);

  onSettingsChanged((next) => {
    applyTheme(next.theme);
    onChange?.(next.theme);
  });

  return settings.theme;
}
