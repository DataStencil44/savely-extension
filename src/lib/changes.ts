import browser from 'webextension-polyfill';

const KEY = 'savely:changed';

const SELF = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;

const COALESCE_MS = 120;

interface ChangeNotice {
  at: number;
  source: string;
}

function isChangeNotice(value: unknown): value is ChangeNotice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['at'] === 'number' && typeof record['source'] === 'string';
}

export function announceChange(): void {
  const notice: ChangeNotice = { at: Date.now(), source: SELF };
  try {
    void browser.storage.local.set({ [KEY]: notice }).catch(() => undefined);
  } catch {
    // ignore
  }
}

export function onDataChanged(listener: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      const change = changes[KEY];
      if (change === undefined) return;
      if (!isChangeNotice(change.newValue) || change.newValue.source === SELF) return;

      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(listener, COALESCE_MS);
    });
  } catch {
    // ignore
  }
}
