/** Stale wstrzykiwane przez `define` w vite.config.ts. */
declare const __TARGET__: 'chrome' | 'firefox';
declare const __DEV__: boolean;

/**
 * Minimalna deklaracja API `offscreen` - istnieje tylko w Chromium i nie ma go
 * w webextension-polyfill. Uzywane wylacznie w `src/lib/offscreen.ts`, przez
 * feature-detect (CLAUDE.md 5.4). W Firefoksie `chrome` istnieje, ale
 * `chrome.offscreen` jest `undefined` - i o to w tym sprawdzeniu chodzi.
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
