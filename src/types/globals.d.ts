declare const __TARGET__: 'chrome' | 'firefox';
declare const __DEV__: boolean;

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
