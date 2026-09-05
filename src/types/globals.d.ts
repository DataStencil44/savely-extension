/** Constants injected through `define` in vite.config.ts. */
declare const __TARGET__: 'chrome' | 'firefox';
declare const __DEV__: boolean;

/**
 * A minimal declaration of the `offscreen` API - it exists only in Chromium and
 * is absent from webextension-polyfill. Used solely in `src/lib/offscreen.ts`,
 * through a feature detect (CLAUDE.md 5.4). In Firefox `chrome` exists but
 * `chrome.offscreen` is `undefined` - which is exactly what that check is for.
 */
declare const chrome:
  | {
      offscreen?: {
        createDocument(parameters: {
          url: string;
          reasons: string[];
          justification: string;
        }): Promise<void>;
        closeDocument(): Promise<void>;
      };
    }
  | undefined;
