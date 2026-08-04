export default [
  {
    ignores: ['**/dist/**', '**/.wrangler/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-throw-literal': 'error',
      'no-constant-condition': 'error',
    },
  },
];
