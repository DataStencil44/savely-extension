/**
 * Feedback for the user: a badge on the icon and a notification on failure.
 * Everything is wrapped in `try/catch`, because Firefox for Android has neither
 * a badge nor (fully) notifications - a missing API must not take down a save
 * that succeeded.
 */
import browser from 'webextension-polyfill';

const BADGE_MS = 2_000;
const BADGE_COLOR = '#2563eb';

async function setBadge(text: string, tabId: number | undefined): Promise<void> {
  try {
    const target = tabId === undefined ? {} : { tabId };
    await browser.action.setBadgeText({ ...target, text });
    if (text !== '') {
      await browser.action.setBadgeBackgroundColor({ ...target, color: BADGE_COLOR });
    }
  } catch {
    // No badge (Android) - stay quiet.
  }
}

export async function clearBadge(tabId?: number): Promise<void> {
  await setBadge('', tabId);
}

/**
 * A "✓" for two seconds. The wait is part of the awaited save path, so the
 * service worker stays alive long enough to clear the badge. If it gets killed
 * anyway, the next save starts with `clearBadge()`.
 */
export async function flashSaved(tabId?: number): Promise<void> {
  await setBadge('✓', tabId);
  await new Promise((resolve) => {
    setTimeout(resolve, BADGE_MS);
  });
  await setBadge('', tabId);
}

export async function notifyProblem(message: string): Promise<void> {
  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-128.png'),
      title: 'Savely',
      message,
    });
  } catch {
    // Without notifications a log remains - better than taking down the save path.
    console.warn('[savely]', message);
  }
}
