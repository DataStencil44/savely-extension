import { loadSettings, onSettingsChanged, saveSettings, type Theme } from './settings';

export const THEME_ORDER: readonly Theme[] = ['light', 'dark', 'sepia', 'auto'];

export const THEME_LABELS: Readonly<Record<Theme, string>> = {
  light: 'Light',
  dark: 'Dark',
  sepia: 'Sepia',
  auto: 'System',
};

export const THEME_ICONS: Readonly<Record<Theme, string>> = {
  light: '\u2600\uFE0E',
  dark: '\u263E',
  sepia: '\u25A4',
  auto: '\u25D0',
};

export function nextTheme(current: Theme): Theme {
  const at = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length] ?? 'light';
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = theme;
}

export async function setTheme(theme: Theme): Promise<Theme> {
  const saved = await saveSettings({ theme });
  applyTheme(saved.theme);
  return saved.theme;
}

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
