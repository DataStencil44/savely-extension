/**
 * ESLint (.eslintrc format) - the file has a .cjs extension because package.json
 * declares "type": "module", while ESLint 8 loads its config through require().
 */
// Anything two pages need lives in `src/ui/shared/`. Without this rule the
// shared module ends up in whichever page happened to need it first, and the
// other pages import *that* - which is how `toast.ts` and `format.ts` came to
// live in `ui/list/` and be imported by the options page and the reader.
const NO_CROSS_PAGE_IMPORTS = {
  group: [
    '@/ui/list/*',
    '@/ui/reader/*',
    '@/ui/options/*',
    '../list/*',
    '../reader/*',
    '../options/*',
  ],
  message: 'A page must not import from another page. Shared UI code belongs in `src/ui/shared/`.',
};

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
    // --- the project's hard rules ---

    // no `any`
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',

    // ESM, consistent type imports
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-require-imports': 'error',

    // Browser APIs exclusively through webextension-polyfill
    'no-restricted-globals': [
      'error',
      {
        name: 'chrome',
        message:
          "Use `import browser from 'webextension-polyfill'` instead of the global `chrome.*` (see CLAUDE.md 5.4).",
      },
    ],

    'no-restricted-syntax': [
      'error',
      {
        // no innerHTML/outerHTML without DOMPurify
        selector:
          "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]:not([right.callee.object.name='DOMPurify'])",
        message:
          'Writing to innerHTML/outerHTML only with the result of DOMPurify.sanitize() (see CLAUDE.md 3).',
      },
      {
        selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
        message:
          'insertAdjacentHTML is forbidden - use DOMPurify.sanitize(..., { RETURN_DOM_FRAGMENT: true }) + append().',
      },
      {
        selector: "MemberExpression[object.name='chrome']",
        message:
          "Use `browser.*` from webextension-polyfill instead of `chrome.*` (see CLAUDE.md 5.4).",
      },
      {
        selector: "CallExpression[callee.name='eval']",
        message: 'eval is forbidden by the Manifest V3 CSP.',
      },
    ],

    // --- hygiene ---
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
      files: ['src/ui/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            // A page reaches the database through `@/lib/library`, whose writes
            // tell the other open pages about themselves (CLAUDE.md 4.12). A
            // write taken straight from `@/lib/db` leaves them showing old data.
            paths: [
              {
                name: '@/lib/db',
                message: 'Pages use `@/lib/library` - its writes announce the change to other pages.',
              },
            ],
            patterns: [NO_CROSS_PAGE_IMPORTS],
          },
        ],
      },
    },
    {
      // Tests set the database up directly; nothing is on screen to announce to.
      files: ['src/ui/**/*.test.ts'],
      rules: {
        'no-restricted-imports': ['error', { patterns: [NO_CROSS_PAGE_IMPORTS] }],
      },
    },
    {
      // the background runs in a service worker (Chrome) / event page (Firefox) - no DOM
      files: ['src/background/**/*.ts'],
      env: { browser: false, worker: true, webextensions: true },
      rules: {
        'no-restricted-globals': [
          'error',
          { name: 'chrome', message: 'Use `browser.*` from webextension-polyfill.' },
          { name: 'document', message: 'The background has no DOM (Chrome MV3 service worker).' },
          { name: 'window', message: 'The background has no `window` (Chrome MV3 service worker).' },
          { name: 'localStorage', message: 'Use IndexedDB (idb) - see CLAUDE.md 5.5.' },
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
      // The e2e tests drive real Chromium. Code inside `page.evaluate` runs in
      // the context of the extension page, where the polyfill is absent and
      // `chrome.*` is the only API - hence the exception to the CLAUDE.md 5.4
      // rule.
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
