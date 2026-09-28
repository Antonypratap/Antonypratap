// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Money, quantities and rates are integers; never parse them loosely.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Use integer paise/milli/bp helpers.' },
      ],
    },
  },
  {
    // ERP boundary (ARCHITECTURE §1): everything outside the fake ERP sees only ErpConnector.
    ignores: ['packages/fake-erp/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@veyra/fake-erp/*'],
              message: 'Use the FakeErpConnector export only; fake_erp.db internals are private.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the fake ERP (and, from Phase 3, the API's own veyra.db) may use SQLite directly.
    files: ['packages/**/*.ts'],
    ignores: ['packages/fake-erp/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['better-sqlite3', 'drizzle-orm'],
          patterns: [
            {
              group: ['drizzle-orm/*'],
              message: 'Only @veyra/fake-erp talks to SQLite among packages.',
            },
            { group: ['@veyra/fake-erp/*'], message: 'Use the FakeErpConnector export only.' },
          ],
        },
      ],
    },
  },
  {
    // ERP and extractor boundary inside the API: workflow code sees only the ErpConnector and
    // Extractor ports. Only the composition root (app.ts) and tests wire in the implementations.
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/app.ts',
      'apps/api/src/**/*.test.ts',
      'apps/api/src/test/**',
      // Demo fixture generation reads the DEMO.md seed (dev tooling, not the runtime path).
      'apps/api/src/imports/fixtures.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@veyra/fake-erp',
              message: 'Use the ErpConnector port; only app.ts wires the fake ERP.',
            },
          ],
          patterns: [{ group: ['@veyra/fake-erp/*'], message: 'Use the ErpConnector port.' }],
        },
      ],
    },
  },
  {
    // The deterministic engine never touches storage: it reads ERP data through the port and
    // returns what should be persisted.
    files: ['apps/api/src/engine/**/*.ts'],
    ignores: ['apps/api/src/engine/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['better-sqlite3', 'drizzle-orm', '@veyra/fake-erp'],
          patterns: [
            {
              group: ['../db/*', '../workflow/*', '../http/*', 'drizzle-orm/*'],
              message: 'The engine is pure: no storage, no HTTP.',
            },
          ],
        },
      ],
    },
  },
  {
    // Web app: browser code with React hooks rules.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
