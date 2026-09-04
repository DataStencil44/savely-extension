/**
 * Informacja zwrotna dla uzytkownika: badge na ikonie i powiadomienie przy
 * bledzie. Wszystko owiniete w `try/catch`, bo Firefox na Androidzie nie ma
 * ani badge'a, ani (czesciowo) powiadomien - brak tych API nie moze wywrocic
 * zapisu, ktory sie udal.
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
    // Brak badge'a (Android) - milczymy.
  }
}

export async function clearBadge(tabId?: number): Promise<void> {
  await setBadge('', tabId);
}

/**
 * "✓" na dwie sekundy. Czekanie jest czescia awaitowanej sciezki zapisu, wiec
 * service worker zyje przez ten czas i zdazy badge zgasic. Gdyby mimo to
 * zostal ubity, kolejny zapis zaczyna od `clearBadge()`.
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
    // Bez powiadomien zostaje log - lepsze to niz wywrocenie sciezki zapisu.
    console.warn('[savely]', message);
  }
}
