/**
 * "The data changed" - the one thing the contexts had no way of telling each
 * other.
 *
 * Every context opens the same IndexedDB and reads it independently, and
 * nothing announced a write. So a page saved from the context menu did not
 * appear in a list that was already open; an article archived in the reader
 * left the list behind it showing it as unread; an import or a sync on the
 * options page reached an open list only if the user happened to reload it.
 * Worse than stale: the list would then act on what it still believed - a
 * favourite toggled from a card that was three states out of date wrote that
 * stale state back.
 *
 * The channel is a single `storage.local` key, for two reasons.
 * `runtime.sendMessage` needs someone listening and would wake the background
 * for a message that is none of its business, and in Chrome MV3 the background
 * is asleep most of the time (CLAUDE.md 5.5). A storage write reaches every
 * open context that cares, and no context that does not.
 *
 * There is no description of *what* changed. Every listener re-reads what it
 * is showing anyway - that is one query for a list that already loads itself
 * whole - and a taxonomy of change kinds would be a second thing to keep in
 * step with the first, for no reader that needs it.
 */
import browser from 'webextension-polyfill';

const KEY = 'savely:changed';

/**
 * Who wrote it. A context ignores its own announcements: it made the change and
 * has already drawn it, and `storage.onChanged` fires in the writing context
 * too.
 */
const SELF = `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;

/**
 * A burst of writes announces itself more than once (a sync that both pulls and
 * pushes, say). Listeners are cheap but not free, so the last one within this
 * window wins.
 */
const COALESCE_MS = 120;

interface ChangeNotice {
  at: number;
  source: string;
}

/** Storage is data from outside the module, like any other (CLAUDE.md 3). */
function isChangeNotice(value: unknown): value is ChangeNotice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['at'] === 'number' && typeof record['source'] === 'string';
}

/**
 * Says that this context has written something the others may be showing.
 *
 * Announce **after** the write has landed, never before: a listener re-reads
 * the database the moment it hears, and would otherwise read the state it was
 * being told had gone.
 */
export function announceChange(): void {
  const notice: ChangeNotice = { at: Date.now(), source: SELF };
  try {
    void browser.storage.local.set({ [KEY]: notice }).catch(() => undefined);
  } catch {
    // A page that misses an announcement shows what it read a moment ago - it
    // is not a broken page, and this is never the reason a save fails. The
    // caller has already written the data; this was the postcard.
  }
}

/** Runs `listener` when another context changes the data. */
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
    // Without change events the page is what it was at load - the state before
    // this channel existed, and still perfectly usable.
  }
}
