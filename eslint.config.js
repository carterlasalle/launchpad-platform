import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['**/dist/**', '**/.wrangler/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.ts', '**/*.d.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      'no-constant-condition': 'error',
    },
  },
];
