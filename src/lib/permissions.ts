import browser from 'webextension-polyfill';

import { hostPattern } from './page-url';

export async function requestHostAccess(url: string): Promise<boolean> {
  const pattern = hostPattern(url);
  if (pattern === null) return false;

  try {
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
