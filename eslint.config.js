// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

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
  prettier,
);
