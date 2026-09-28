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
    // Web app: browser code with React hooks rules.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
