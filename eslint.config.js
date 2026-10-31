import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const commonRules = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
};

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'none',
};

export default [
  {
    ignores: ['**/node_modules/**', 'web/dist/**', 'data/**', 'coverage/**'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    ...js.configs.recommended,
    files: ['server/**/*.js'],
  },
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...commonRules,
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    ...js.configs.recommended,
    files: ['web/src/**/*.ts', 'web/test/**/*.ts'],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['web/src/**/*.ts', 'web/test/**/*.ts'],
  })),
  {
    files: ['web/src/**/*.ts', 'web/test/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...commonRules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['eslint.config.js', 'web/vite.config.ts', 'web/vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
];
