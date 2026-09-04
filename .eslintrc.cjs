/**
 * ESLint (format .eslintrc) - plik ma rozszerzenie .cjs, bo package.json
 * deklaruje "type": "module", a ESLint 8 ladunek konfiguracji robi przez require().
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    webextensions: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
  ],
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs'],
  rules: {
    // --- twarde zasady projektu ---

    // brak `any`
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',

    // ESM, spojne importy typow
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-require-imports': 'error',

    // API przegladarki wylacznie przez webextension-polyfill
    'no-restricted-globals': [
      'error',
      {
        name: 'chrome',
        message:
          "Uzyj `import browser from 'webextension-polyfill'` zamiast globalnego `chrome.*` (patrz CLAUDE.md 5.4).",
      },
    ],

    'no-restricted-syntax': [
      'error',
      {
        // brak innerHTML/outerHTML bez DOMPurify
        selector:
          "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]:not([right.callee.object.name='DOMPurify'])",
        message:
          'Zapis do innerHTML/outerHTML tylko z wynikiem DOMPurify.sanitize() (patrz CLAUDE.md 3).',
      },
      {
        selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
        message:
          'insertAdjacentHTML jest zabronione - uzyj DOMPurify.sanitize(..., { RETURN_DOM_FRAGMENT: true }) + append().',
      },
      {
        selector: "MemberExpression[object.name='chrome']",
        message:
          "Uzyj `browser.*` z webextension-polyfill zamiast `chrome.*` (patrz CLAUDE.md 5.4).",
      },
      {
        selector: "CallExpression[callee.name='eval']",
        message: 'eval jest zabronione przez CSP Manifest V3.',
      },
    ],

    // --- higiena ---
    eqeqeq: ['error', 'always'],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-var': 'error',
    'prefer-const': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // background dziala w service workerze (Chrome) / event page (Firefox) - bez DOM
      files: ['src/background/**/*.ts'],
      env: { browser: false, worker: true, webextensions: true },
      rules: {
        'no-restricted-globals': [
          'error',
          { name: 'chrome', message: 'Uzyj `browser.*` z webextension-polyfill.' },
          { name: 'document', message: 'Background nie ma DOM (Chrome MV3 service worker).' },
          { name: 'window', message: 'Background nie ma `window` (Chrome MV3 service worker).' },
          { name: 'localStorage', message: 'Uzyj IndexedDB (idb) - patrz CLAUDE.md 5.5.' },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      env: { node: true },
      rules: { 'no-console': 'off' },
    },
    {
      files: ['vite.config.ts', 'playwright.config.ts', 'build/**/*.ts'],
      env: { node: true, browser: false },
      rules: { 'no-console': 'off' },
    },
    {
      // Testy e2e sterują prawdziwym Chromium. Kod w `page.evaluate` wykonuje
      // się w kontekście strony rozszerzenia, gdzie polyfilla nie ma i `chrome.*`
      // jest jedynym API - stąd wyjątek od reguły z CLAUDE.md 5.4.
      files: ['tests/e2e/**/*.ts'],
      env: { node: true, browser: true },
      rules: {
        'no-console': 'off',
        'no-restricted-globals': 'off',
        'no-restricted-syntax': 'off',
      },
    },
  ],
};
