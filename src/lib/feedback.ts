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
    // ignore
  }
}

export async function clearBadge(tabId?: number): Promise<void> {
  await setBadge('', tabId);
}

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
    console.warn('[savely]', message);
  }
}
