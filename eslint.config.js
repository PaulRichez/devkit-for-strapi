// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.vscode-test/**',
      '**/.astro/**',
      'packages/test-fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Node build/util scripts (plain JS, run by Node directly).
    files: ['**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
