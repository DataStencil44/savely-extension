/**
 * Host permissions requested at runtime.
 *
 * In Firefox MV3 host permissions are withheld by default, so asking the user
 * on the first save from a given site is the **normal flow**, not an error
 * (CLAUDE.md 5.3). In Chrome, when consent is already there, `request()`
 * returns `true` without any dialog.
 *
 * `permissions.request()` has to originate from a user gesture and be the
 * **first** `await` in the click handler - hence this function is as flat as
 * it can be.
 */
import browser from 'webextension-polyfill';

import { hostPattern } from './page-url';

export async function requestHostAccess(url: string): Promise<boolean> {
  const pattern = hostPattern(url);
  if (pattern === null) return false;

  try {
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    // No user gesture, or a pattern outside `optional_host_permissions`.
    return false;
  }
}
